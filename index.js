import {Asset, Keypair, Networks, Operation, Server, TransactionBuilder} from 'stellar-sdk';
import fetch from 'node-fetch';
import { readFileSync } from 'fs';

const server = new Server('https://horizon.stellar.org');
const rebalanceAutomatically = true;
const markets = JSON.parse(readFileSync('./config.json').toString());

async function reset() {
  for (const market of markets) {
    if (!market.secret) {
      console.log('Please put Stellar account secret into config')
      continue;
    }
    const keypair = Keypair.fromSecret(market.secret);

    const ratePromise = fetch('https://rates.apay.io')
      .then((response) => {
        return response.json();
      })
      .then((result) => {
        if (!result.USD) {
          throw new Error('rates are not available yet');
        }
        return parseFloat(result[market.base.rate]) / parseFloat(result[market.quote.rate]);
      });

    const baseAsset = new Asset(market.base.code, market.base.issuer);
    const quoteAsset = new Asset(market.quote.code, market.quote.issuer)
    const accountPromise = server.loadAccount(keypair.publicKey());

    const offersPromise = server.offers().forAccount(keypair.publicKey()).call()
      .then((result) => {
        return result.records.map((v) => {
          return {
            offerId: v.id,
            account: v.seller,
            sellingAssetType: v.selling.asset_type,
            sellingAssetCode: v.selling.asset_code,
            sellingAssetIssuer: v.selling.asset_issuer,
            buyingAssetType: v.buying.asset_type,
            buyingAssetCode: v.buying.asset_code,
            buyingAssetIssuer: v.buying.asset_issuer,
            amount: v.amount,
            price: v.price
          }
        });
      });

    Promise.all([ratePromise, accountPromise, offersPromise])
      .then(([rate, account, offers]) => {
        const baseAssetBalance = getAssetBalance(account, baseAsset);
        const quoteAssetBalance = getAssetBalance(account, quoteAsset);
        const ratio = rebalanceAutomatically ? quoteAssetBalance / (quoteAssetBalance + baseAssetBalance / rate) : 0.5;
        console.log(rate, baseAsset.code, '/', quoteAsset.code, quoteAssetBalance, baseAssetBalance / rate, ratio);

        const txBuilder = new TransactionBuilder(account, {
          fee: '200',
          networkPassphrase: Networks.PUBLIC,
        });

        offers.forEach((offer) => {
          txBuilder.addOperation(removeOffer(offer, keypair.publicKey()));
        });

        if (quoteAssetBalance) {
          let sum = 0;
          market.levels.forEach((offset) => {
            const amount = (Math.min(quoteAssetBalance / market.levels.length, quoteAssetBalance - sum)).toFixed(7);
            if (parseFloat(amount) > 0) {
              txBuilder
                .addOperation(Operation.manageSellOffer({
                  selling: quoteAsset,
                  buying: baseAsset,
                  amount: amount,
                  price: (rate * (1 + offset + (0.5 - ratio) * market.levels[0])).toFixed(7),
                }));
              // console.log((rate * (1 + offset + (0.5 - ratio) * levels[0])).toFixed(7));
              sum += parseFloat(amount);
            }
          });
        }

        if (baseAssetBalance) {
          let sum = 0;
          market.levels.forEach((offset) => {
            const amount = (Math.min(baseAssetBalance / market.levels.length, baseAssetBalance - sum)).toFixed(7);
            if (parseFloat(amount) > 0) {
              txBuilder
                .addOperation(Operation.manageSellOffer({
                  selling: baseAsset,
                  buying: quoteAsset,
                  amount: amount,
                  price: (1 / rate / (1 - offset - (0.5 - ratio) * market.levels[0])).toFixed(7),
                }));
              // console.log((rate * (1 - offset - (0.5 - ratio) * levels[0])).toFixed(7))
              sum += parseFloat(amount);
            }
          });
        }

        const tx = txBuilder.setTimeout(30).build();

        tx.sign(keypair);
        // console.log(tx.toEnvelope().toXDR().toString('base64'));
        return server.submitTransaction(tx);
      })
      .then(() => {
        console.log('sent tx successfully');
      })
      .catch((err) => {
        console.error(err.message, err.response && err.response.data || err);
      });
  }
}

function getXLMBalance(account) {
  return Math.max(0, parseFloat(account.balances.find((balance) => {
    return balance.asset_type === 'native';
  }).balance) - 10);
}

function getAssetBalance(account, asset) {
  if (!asset.issuer) {
    return getXLMBalance(account);
  }
  const balance = account.balances.find((balance) => {
    return balance.asset_code === asset.getCode() && balance.asset_issuer === asset.getIssuer();
  });
  return balance ? parseFloat(balance.balance) : 0;
}

function removeOffer(offer, source) {
  return Operation.manageSellOffer({
    selling: offer.sellingAssetType === 'native' ? Asset.native() : (
      new Asset(offer.sellingAssetCode, offer.sellingAssetIssuer)
    ),
    buying: offer.buyingAssetType === 'native' ? Asset.native() : (
      new Asset(offer.buyingAssetCode, offer.buyingAssetIssuer)
    ),
    amount: '0.0000000',
    price: offer.price,
    offerId: offer.offerId,
  })
}


setInterval(reset, 30000 + Math.random() * 60000);
reset();
