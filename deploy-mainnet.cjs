#!/usr/bin/env node
// Deploy MinaliaVerifier SmartContract to Mina mainnet.
//
// One-shot script: run ONCE to install the contract at the zkApp address.
// After that, on-chain verification recording via record-onchain.cjs will work.
//
// REQUIRES these env vars (set via GitHub Actions secrets):
//   ZKAPP_PRIVATE_KEY - Private key of the zkApp account (EK... format).
//                       This account must already exist on mainnet with enough
//                       MINA for the deploy fee (~0.1 MINA).
//   ZKAPP_ADDRESS     - Public address of the same account (B62q... format).
//
// Refuses to start if either is missing, and checks that the private key
// derives to the configured public address before spending any MINA.
//
// The deploy spends ~0.1 MINA in fees. No account creation fee needed because
// the zkApp address already exists as a funded regular account.

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Required env vars ──
const ZKAPP_PRIVATE_KEY = process.env.ZKAPP_PRIVATE_KEY;
const ZKAPP_ADDRESS     = process.env.ZKAPP_ADDRESS;

function requireEnv(name, value) {
  if (!value) {
    console.error('FATAL: ' + name + ' env var is not set.');
    console.error('Set it as a GitHub Actions secret and pass it through in');
    console.error('.github/workflows/deploy-mainnet.yml env: block.');
    process.exit(1);
  }
}
requireEnv('ZKAPP_PRIVATE_KEY', ZKAPP_PRIVATE_KEY);
requireEnv('ZKAPP_ADDRESS',     ZKAPP_ADDRESS);

// Write a temporary TS project in a tmp dir, compile it, run it.
// Same pattern as record-onchain.cjs — isolates the o1js instance from anything
// else and avoids CJS/ESM conflicts.
const tmpDir = path.join(__dirname, 'tmp-mainnet-deploy');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
  name: 'tmp-mainnet-deploy',
  type: 'module',
  dependencies: { o1js: '2.14.0' },
  devDependencies: { '@types/node': '^20.0.0', typescript: '^5.0.0' }
}));

fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2021', module: 'NodeNext', moduleResolution: 'NodeNext',
    experimentalDecorators: true, emitDecoratorMetadata: true,
    strict: false, skipLibCheck: true, outDir: 'dist', types: ['node']
  },
  include: ['*.ts']
}));

// NOTE: ZKAPP_PRIVATE_KEY is NOT inlined into the generated TS — it's read from
// env inside the child process. This means the compiled .js file on disk never
// contains the private key, even if this script leaves the tmp dir behind.
fs.writeFileSync(path.join(tmpDir, 'deploy.ts'), `
import { SmartContract, state, State, method, Field, PublicKey, Struct, Mina, PrivateKey, fetchAccount } from 'o1js';

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
  const ZKAPP_PRIV = process.env.ZKAPP_PRIVATE_KEY;
  const ZKAPP_ADDR = process.env.ZKAPP_ADDRESS;
  if (!ZKAPP_PRIV || !ZKAPP_ADDR) {
    console.error('FATAL: env vars missing in child process.');
    process.exit(1);
  }

  Mina.setActiveInstance(Mina.Network({
    mina:    'https://api.minascan.io/node/mainnet/v1/graphql',
    archive: 'https://api.minascan.io/archive/mainnet/v1/graphql',
    networkId: 'mainnet',
  }));

  const zkKey = PrivateKey.fromBase58(ZKAPP_PRIV);
  const zkPub = PublicKey.fromBase58(ZKAPP_ADDR);

  // Key pair sanity check: refuse to send any tx if the configured address
  // doesn't match the derived one.
  const derived = zkKey.toPublicKey().toBase58();
  if (derived !== ZKAPP_ADDR) {
    console.error('FATAL: ZKAPP_ADDRESS does not match ZKAPP_PRIVATE_KEY.');
    console.error('  Configured:', ZKAPP_ADDR);
    console.error('  Derived   :', derived);
    process.exit(1);
  }
  console.log('zkApp key pair verified. Address:', derived);

  // Check the account exists on mainnet with enough funds.
  const { account } = await fetchAccount({ publicKey: zkPub });
  if (!account) {
    console.error('FATAL: zkApp address not found on mainnet.');
    console.error('Fund it with MINA first, then retry.');
    process.exit(1);
  }

  const balanceMina = Number(account.balance.toBigInt()) / 1e9;
  console.log('Account found. Balance:', balanceMina, 'MINA');

  if (account.zkapp) {
    console.log('\\n✓ Contract already deployed at this address.');
    console.log('  (zkApp state:', account.zkapp.appState?.slice(0, 3), '...)');
    console.log('  Nothing to do. Exiting successfully.');
    process.exit(0);
  }

  if (balanceMina < 0.2) {
    console.error('FATAL: Insufficient balance. Need at least 0.2 MINA for deploy fee.');
    console.error('  Current:', balanceMina, 'MINA');
    process.exit(1);
  }

  console.log('\\nCompiling MinaliaVerifier SmartContract...');
  const { verificationKey } = await MinaliaVerifier.compile();
  console.log('Compiled. VK hash:', verificationKey.hash.toString());

  console.log('\\nBuilding deploy transaction...');
  const zkApp = new MinaliaVerifier(zkPub);

  // Single-account deploy: this same account pays the fee AND is the zkApp.
  // No AccountUpdate.fundNewAccount needed because the account already exists.
  const tx = await Mina.transaction(
    { sender: zkPub, fee: 100_000_000, memo: 'Minalia zkApp deploy' }, // 0.1 MINA fee
    async () => { await zkApp.deploy(); }
  );

  console.log('Proving transaction (this takes 30-90 seconds)...');
  await tx.prove();
  tx.sign([zkKey]);

  console.log('Sending to mainnet...');
  const sent = await tx.send();

  console.log('\\n✓ DEPLOY TRANSACTION SENT');
  console.log('  TX hash :', sent.hash);
  console.log('  Minascan: https://minascan.io/mainnet/tx/' + sent.hash);
  console.log('\\nThe contract will be live after ~3-5 minutes (time to confirm).');
  console.log('After confirmation, the record-onchain workflow will succeed for');
  console.log('any future verification.');
}

main().catch(e => {
  console.error('Deploy failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
`);

console.log('Installing dependencies in tmp dir...');
execSync('npm install', { cwd: tmpDir, stdio: 'inherit' });
console.log('Compiling TypeScript...');
execSync('npx tsc', { cwd: tmpDir, stdio: 'inherit' });
console.log('Running deploy...\n');

// Pass ZKAPP_* env vars explicitly to the child process.
execFileSync('node', ['dist/deploy.js'], {
  cwd: tmpDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    ZKAPP_PRIVATE_KEY,
    ZKAPP_ADDRESS,
  }
});
