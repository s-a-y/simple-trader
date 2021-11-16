import {Asset, Keypair, Networks, Operation, Server, TransactionBuilder} from 'stellar-sdk';
import fetch from 'node-fetch';

const server = new Server('https://horizon.stellar.org');
const keypair = Keypair.fromSecret(process.env.SECRET);
const levels = [
  0.001,
  0.0015,
  0.002,
]
const rebalanceAutomatically = true;

async function reset() {
  const ratePromise = fetch('https://api.kraken.com/0/public/Ticker?pair=XXLMZUSD')
    .then((response) => {
      return response.json();
    })
    .then((result) => {
      return result.result.XXLMZUSD.c[0];
    });

  const asset = new Asset('LIBERTAD', 'GCRFFNWYQYLVVA43CD2RVFDILBLIFVBTGTXKVVMTJKBRC6PZWYQOAWCQ');
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
      const xlmBalance = getXLMBalance(account);
      const assetBalance = getAssetBalance(account, asset);
      const ratio = rebalanceAutomatically ? xlmBalance / (xlmBalance + assetBalance / rate) : 0.5;
      console.log(rate, xlmBalance, assetBalance / rate, ratio);

      const txBuilder = new TransactionBuilder(account, {
        fee: '200',
        networkPassphrase: Networks.PUBLIC,
      });

      offers.forEach((offer) => {
        txBuilder.addOperation(removeOffer(offer, keypair.publicKey()));
      });

      if (xlmBalance) {
        let sum = 0;
        levels.forEach((offset) => {
          const amount = (Math.min(xlmBalance / levels.length, xlmBalance - sum)).toFixed(7);
          if (parseFloat(amount) > 0) {
            txBuilder
              .addOperation(Operation.manageSellOffer({
                selling: Asset.native(),
                buying: asset,
                amount: amount,
                price: (rate * (1 + offset + (0.5 - ratio) * levels[0])).toFixed(7),
              }));
            // console.log((rate * (1 + offset + (0.5 - ratio) * levels[0])).toFixed(7));
            sum += parseFloat(amount);
          }
        });
      }

      if (assetBalance) {
        let sum = 0;
        levels.forEach((offset) => {
          const amount = (Math.min(assetBalance / levels.length, assetBalance - sum)).toFixed(7);
          if (parseFloat(amount) > 0) {
            txBuilder
              .addOperation(Operation.manageSellOffer({
                selling: asset,
                buying: Asset.native(),
                amount: amount,
                price: (1 / rate / (1 - offset - (0.5 - ratio) * levels[0])).toFixed(7),
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
    .then(() => {console.log('sent tx successfully'); })
    .catch((err) => {
      console.error(err.message, err.response && err.response.data || err);
    });
}

function getXLMBalance(account) {
  return Math.max(0, parseFloat(account.balances.find((balance) => {
    return balance.asset_type === 'native';
  }).balance) - 10);
}

function getAssetBalance(account, asset) {
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
