/**
 * Deploy MinaliaVerifier to Mina Devnet
 * 
 * Usage: node deploy.mjs
 * 
 * Requires:
 *   SERVER_PRIVATE_KEY env var (the Minalia server key)
 *   — This wallet pays the deployment fee and becomes the zkApp deployer
 */

import { MinaliaVerifier } from './MinaliaVerifier.mjs';
import {
  Mina, PrivateKey, PublicKey, AccountUpdate, fetchAccount
} from 'o1js';

const DEVNET_URL = 'https://api.minascan.io/node/devnet/v1/graphql';
const ARCHIVE_URL = 'https://api.minascan.io/archive/devnet/v1/graphql';

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY
  || 'EKDxrPaymujx8HjZJ5iWLLQ4nCyyGa5HieoTEwdcX6T1GvPJgvv4';

async function deploy() {
  console.log('=== Minalia zkApp Deployer ===\n');

  // Connect to Devnet
  const network = Mina.Network({
    mina:    DEVNET_URL,
    archive: ARCHIVE_URL,
  });
  Mina.setActiveInstance(network);

  const deployerKey    = PrivateKey.fromBase58(SERVER_PRIVATE_KEY);
  const deployerPubKey = deployerKey.toPublicKey();

  console.log('Deployer wallet:', deployerPubKey.toBase58());

  // Check balance
  await fetchAccount({ publicKey: deployerPubKey });
  const account = Mina.getAccount(deployerPubKey);
  console.log('Balance:', Number(account.balance.toBigInt()) / 1e9, 'MINA\n');

  if (account.balance.toBigInt() < 1_000_000_000n) {
    throw new Error('Insufficient balance — need at least 1 MINA');
  }

  // Generate a fresh zkApp keypair
  const zkAppKey    = PrivateKey.random();
  const zkAppPubKey = zkAppKey.toPublicKey();

  console.log('zkApp address:', zkAppPubKey.toBase58());
  console.log('zkApp private key:', zkAppKey.toBase58());
  console.log('SAVE THE ABOVE — needed for future transactions\n');

  // Compile
  console.log('Compiling MinaliaVerifier...');
  await MinaliaVerifier.compile();
  console.log('Compiled.\n');

  // Deploy transaction
  console.log('Building deploy transaction...');
  const zkApp = new MinaliaVerifier(zkAppPubKey);

  const deployTx = await Mina.transaction(
    { sender: deployerPubKey, fee: 100_000_000 }, // 0.1 MINA fee
    async () => {
      AccountUpdate.fundNewAccount(deployerPubKey);
      await zkApp.deploy();
    }
  );

  await deployTx.prove();
  deployTx.sign([deployerKey, zkAppKey]);

  console.log('Sending deploy transaction...');
  const result = await deployTx.send();
  const txHash = result.hash;

  console.log('\n✅ zkApp deployed!');
  console.log('Transaction hash:', txHash);
  console.log('View on Minascan: https://minascan.io/devnet/tx/' + txHash);
  console.log('\nAdd to Railway env vars:');
  console.log('  ZKAPP_ADDRESS=' + zkAppPubKey.toBase58());
  console.log('  ZKAPP_PRIVATE_KEY=' + zkAppKey.toBase58());
  console.log('  MINA_NETWORK=devnet');
}

deploy().catch(err => {
  console.error('Deploy failed:', err.message);
  process.exit(1);
});
