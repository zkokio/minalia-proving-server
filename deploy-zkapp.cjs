#!/usr/bin/env node
/**
 * MinaliaVerifier deploy script
 * Run: node deploy-zkapp.cjs
 * Uses zkapp-cli approach — compiles TS on-the-fly
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Write a temporary TS project
const tmpDir = path.join(__dirname, 'tmp-deploy');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
  name: 'tmp-deploy', type: 'module',
  dependencies: { o1js: '^2.1.0' }, devDependencies: { '@types/node': '^20.0.0', typescript: '^5.0.0' }
}));

fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2021', module: 'NodeNext', moduleResolution: 'NodeNext',
    experimentalDecorators: true, emitDecoratorMetadata: true,
    strict: false, skipLibCheck: true, outDir: 'dist', types: ['node']
  },
  include: ['*.ts']
}));

fs.writeFileSync(path.join(tmpDir, 'deploy.ts'), `
import { SmartContract, state, State, method, Field, PublicKey, Struct, Mina, PrivateKey, AccountUpdate, fetchAccount } from 'o1js';

class VerificationEvent extends Struct({
  walletX: Field, walletY: Field,
  proofHashLow: Field, proofHashHigh: Field, dayTimestamp: Field,
}) {}

class MinaliaVerifier extends SmartContract {
  @state(Field) totalVerifications = State<Field>();
  @state(Field) lastWalletX        = State<Field>();
  @state(Field) lastProofHashLow   = State<Field>();
  @state(Field) lastProofHashHigh  = State<Field>();
  @state(Field) lastDayTimestamp   = State<Field>();
  events = { verification: VerificationEvent };

  init() {
    super.init();
    this.totalVerifications.set(Field(0));
    this.lastWalletX.set(Field(0));
    this.lastProofHashLow.set(Field(0));
    this.lastProofHashHigh.set(Field(0));
    this.lastDayTimestamp.set(Field(0));
  }

  @method async recordVerification(
    walletPublicKey: PublicKey, proofHashLow: Field, proofHashHigh: Field, dayTimestamp: Field,
  ) {
    const total = this.totalVerifications.getAndRequireEquals();
    this.totalVerifications.set(total.add(Field(1)));
    this.lastWalletX.set(walletPublicKey.x);
    this.lastProofHashLow.set(proofHashLow);
    this.lastProofHashHigh.set(proofHashHigh);
    this.lastDayTimestamp.set(dayTimestamp);
    this.emitEvent('verification', new VerificationEvent({
      walletX: walletPublicKey.x, walletY: walletPublicKey.toGroup().y,
      proofHashLow, proofHashHigh, dayTimestamp,
    }));
  }
}

async function main() {
  const DEVNET  = 'https://api.minascan.io/node/devnet/v1/graphql';
  const ARCHIVE = 'https://api.minascan.io/archive/devnet/v1/graphql';
  const SERVER_KEY = process.env.SERVER_PRIVATE_KEY || 'EKDxrPaymujx8HjZJ5iWLLQ4nCyyGa5HieoTEwdcX6T1GvPJgvv4';

  Mina.setActiveInstance(Mina.Network({ mina: DEVNET, archive: ARCHIVE }));
  const deployerKey = PrivateKey.fromBase58(SERVER_KEY);
  const deployerPub = deployerKey.toPublicKey();

  console.log('Deployer:', deployerPub.toBase58());
  const r = await fetchAccount({ publicKey: deployerPub });
  if (!r.account) throw new Error('Account not found — faucet may still be processing');
  console.log('Balance:', Number(r.account.balance.toBigInt()) / 1e9, 'MINA');

  const zkKey = PrivateKey.random();
  const zkPub = zkKey.toPublicKey();

  console.log('\\nCompiling MinaliaVerifier...');
  await MinaliaVerifier.compile();
  console.log('Compiled.');

  const zkApp = new MinaliaVerifier(zkPub);
  const tx = await Mina.transaction({ sender: deployerPub, fee: 100_000_000 }, async () => {
    AccountUpdate.fundNewAccount(deployerPub);
    await zkApp.deploy();
  });
  await tx.prove();
  tx.sign([deployerKey, zkKey]);

  console.log('Sending deploy transaction...');
  const sent = await tx.send();

  console.log('\\n✅ DEPLOYED SUCCESSFULLY!');
  console.log('Transaction hash:', sent.hash);
  console.log('Minascan: https://minascan.io/devnet/tx/' + sent.hash);
  console.log('\\n⚠️  SAVE THESE — add to Railway environment variables:');
  console.log('ZKAPP_ADDRESS=' + zkPub.toBase58());
  console.log('ZKAPP_PRIVATE_KEY=' + zkKey.toBase58());
  console.log('MINA_NETWORK=devnet');
}

main().catch(e => { console.error('Deploy failed:', e.message); process.exit(1); });
`);

// Install deps and compile
console.log('Installing dependencies...');
execSync('npm install', { cwd: tmpDir, stdio: 'inherit' });
console.log('Compiling TypeScript...');
execSync('npx tsc', { cwd: tmpDir, stdio: 'inherit' });
console.log('Running deploy...\n');
const { execFileSync } = require('child_process');
execFileSync('node', ['dist/deploy.js'], {
  cwd: tmpDir,
  stdio: 'inherit',
  env: { ...process.env }
});
