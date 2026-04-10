// One-time mainnet deploy script — run via GitHub Actions
// Uses zkApp key as fee payer since that address holds the 99.75 MINA

import { Mina, PrivateKey, AccountUpdate, fetchAccount } from 'o1js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { MinaliaVerifier } = require('./MinaliaVerifier.cjs');

const ZKAPP_PRIVATE_KEY = 'EKEbTpyViqHqqhL5CBwEfbuk2xgtakja8vciLY33juYAvGEPjCUS';

Mina.setActiveInstance(Mina.Network({
  mina:    'https://api.minascan.io/node/mainnet/v1/graphql',
  archive: 'https://api.minascan.io/archive/mainnet/v1/graphql',
}));

const zkAppKey = PrivateKey.fromBase58(ZKAPP_PRIVATE_KEY);
const zkAppPub = zkAppKey.toPublicKey();

console.log('zkApp address (fee payer):', zkAppPub.toBase58());

const zkAcc = await fetchAccount({ publicKey: zkAppPub });
console.log('Account exists:', !!zkAcc.account);
console.log('Balance:', zkAcc.account?.balance?.toString());
console.log('Already a zkApp:', !!zkAcc.account?.zkapp);

if (zkAcc.account?.zkapp) {
  console.log('Already deployed on mainnet — done.');
  process.exit(0);
}

if (!zkAcc.account) {
  console.error('Account not found on mainnet. Fund the address first.');
  process.exit(1);
}

console.log('Compiling MinaliaVerifier...');
await MinaliaVerifier.compile();
console.log('Compiled. Deploying...');

// Self-deploy: zkApp key is both fee payer and contract key
const tx = await Mina.transaction({ sender: zkAppPub, fee: 100_000_000 }, async () => {
  const zkApp = new MinaliaVerifier(zkAppPub);
  await zkApp.deploy();
});

await tx.prove();
tx.sign([zkAppKey]);
const sent = await tx.send();
console.log('Deploy tx hash:', sent.hash);
console.log('Explorer: https://minascan.io/mainnet/tx/' + sent.hash);
