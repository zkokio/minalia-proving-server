// Run once to deploy MinaliaVerifier to mainnet
// node deploy-mainnet.mjs

import { Mina, PrivateKey, AccountUpdate } from 'o1js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { MinaliaVerifier } = require('./MinaliaVerifier.cjs');

const ZKAPP_PRIVATE_KEY = 'EKEbTpyViqHqqhL5CBwEfbuk2xgtakja8vciLY33juYAvGEPjCUS';
const SERVER_PRIVATE_KEY = 'EKDxrPaymujx8HjZJ5iWLLQ4nCyyGa5HieoTEwdcX6T1GvPJgvv4';

const network = Mina.Network({
  mina:    'https://api.minascan.io/node/mainnet/v1/graphql',
  archive: 'https://api.minascan.io/archive/mainnet/v1/graphql',
});
Mina.setActiveInstance(network);

const zkAppKey    = PrivateKey.fromBase58(ZKAPP_PRIVATE_KEY);
const zkAppPub    = zkAppKey.toPublicKey();
const serverKey   = PrivateKey.fromBase58(SERVER_PRIVATE_KEY);
const serverPub   = serverKey.toPublicKey();

console.log('zkApp address:', zkAppPub.toBase58());
console.log('Fee payer:    ', serverPub.toBase58());

console.log('Compiling MinaliaVerifier...');
await MinaliaVerifier.compile();
console.log('Compiled.');

const { fetchAccount } = await import('o1js');
const serverAcc = await fetchAccount({ publicKey: serverPub });
console.log('Server account nonce:', serverAcc.account?.nonce?.toString());

const zkAcc = await fetchAccount({ publicKey: zkAppPub });
const alreadyDeployed = zkAcc.account?.zkapp !== undefined;
console.log('zkApp already deployed on mainnet:', alreadyDeployed);

if (alreadyDeployed) {
  console.log('Already deployed — no action needed.');
  process.exit(0);
}

console.log('Deploying to mainnet...');
const tx = await Mina.transaction({ sender: serverPub, fee: 100_000_000 }, async () => {
  AccountUpdate.fundNewAccount(serverPub);
  const zkApp = new MinaliaVerifier(zkAppPub);
  await zkApp.deploy();
});

await tx.prove();
tx.sign([serverKey, zkAppKey]);
const sent = await tx.send();
console.log('Deploy tx hash:', sent.hash);
console.log('Explorer: https://minascan.io/mainnet/tx/' + sent.hash);
