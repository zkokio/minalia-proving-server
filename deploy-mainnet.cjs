// One-time mainnet deploy — pure CJS so o1js instance is consistent
const { MinaliaVerifier } = require('./MinaliaVerifier.cjs');
const { Mina, PrivateKey, fetchAccount } = require('o1js');

const ZKAPP_PRIVATE_KEY = 'EKEbTpyViqHqqhL5CBwEfbuk2xgtakja8vciLY33juYAvGEPjCUS';

async function main() {
  Mina.setActiveInstance(Mina.Network({
    mina:    'https://api.minascan.io/node/mainnet/v1/graphql',
    archive: 'https://api.minascan.io/archive/mainnet/v1/graphql',
  }));

  const zkAppKey = PrivateKey.fromBase58(ZKAPP_PRIVATE_KEY);
  const zkAppPub = zkAppKey.toPublicKey();
  console.log('zkApp address:', zkAppPub.toBase58());

  const { account } = await fetchAccount({ publicKey: zkAppPub });
  console.log('Account exists:', !!account);
  console.log('Balance:', account?.balance?.toString());

  if (!account) { console.error('Not funded on mainnet.'); process.exit(1); }
  if (account?.zkapp) { console.log('Already deployed!'); process.exit(0); }

  console.log('Compiling...');
  await MinaliaVerifier.compile();
  console.log('Compiled. Deploying...');

  const tx = await Mina.transaction({ sender: zkAppPub, fee: 100_000_000 }, async () => {
    const zkApp = new MinaliaVerifier(zkAppPub);
    await zkApp.deploy();
  });
  await tx.prove();
  tx.sign([zkAppKey]);
  const sent = await tx.send();
  console.log('Deploy tx hash:', sent.hash);
  console.log('Explorer: https://minascan.io/mainnet/tx/' + sent.hash);
}

main().catch(e => { console.error(e.message); process.exit(1); });
