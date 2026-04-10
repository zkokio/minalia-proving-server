#!/usr/bin/env node
// Pure CJS mainnet deploy — writes TS inline, compiles and runs it
// No ESM/CJS o1js instance conflicts

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ZKAPP_PRIVATE_KEY = 'EKEbTpyViqHqqhL5CBwEfbuk2xgtakja8vciLY33juYAvGEPjCUS';
const ZKAPP_ADDRESS     = 'B62qoT7pZo8Lhh42ZXuD88xUBGvkFKHdVBahjUXEHAZFWkFquJBMxRi';

const tmpDir = path.join(__dirname, 'tmp-mainnet-deploy');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
  name: 'tmp-mainnet-deploy', type: 'module',
  dependencies: { o1js: '^2.1.0' },
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

fs.writeFileSync(path.join(tmpDir, 'deploy.ts'), `
import { SmartContract, state, State, method, Field, PublicKey, Struct, Mina, PrivateKey, fetchAccount, AccountUpdate } from 'o1js';

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
  const MAINNET = 'https://api.minascan.io/node/mainnet/v1/graphql';
  const ARCHIVE = 'https://api.minascan.io/archive/mainnet/v1/graphql';
  const ZKAPP_PRIVATE_KEY = '${ZKAPP_PRIVATE_KEY}';
  const ZKAPP_ADDRESS     = '${ZKAPP_ADDRESS}';

  Mina.setActiveInstance(Mina.Network({ mina: MAINNET, archive: ARCHIVE }));

  const zkKey = PrivateKey.fromBase58(ZKAPP_PRIVATE_KEY);
  const zkPub = PublicKey.fromBase58(ZKAPP_ADDRESS);

  console.log('zkApp address:', zkPub.toBase58());

  const { account } = await fetchAccount({ publicKey: zkPub });
  console.log('Account found:', !!account);
  console.log('Balance:', account ? Number(account.balance.toBigInt()) / 1e9 + ' MINA' : 'N/A');

  if (!account) { console.error('Account not found on mainnet.'); process.exit(1); }
  if (account.zkapp) { console.log('Already deployed!'); process.exit(0); }

  console.log('Compiling MinaliaVerifier...');
  await MinaliaVerifier.compile();
  console.log('Compiled. Deploying...');

  // Fetch nonce explicitly to avoid stale nonce issues
  const { account: freshAccount } = await fetchAccount({ publicKey: zkPub });
  const nonce = Number(freshAccount?.nonce ?? 0);
  console.log('Nonce:', nonce);

  const zkApp = new MinaliaVerifier(zkPub);
  const tx = await Mina.transaction({ sender: zkPub, fee: 100_000_000, nonce, memo: 'Minalia zkApp deploy' }, async () => {
    await zkApp.deploy();
  });
  await tx.prove();
  tx.sign([zkKey]);

  console.log('Sending deploy transaction...');
  const sent = await tx.send();

  console.log('\\n✅ DEPLOYED SUCCESSFULLY!');
  console.log('Transaction hash:', sent.hash);
  console.log('Minascan: https://minascan.io/mainnet/tx/' + sent.hash);
}

main().catch(e => { console.error('Deploy failed:', e.message); process.exit(1); });
`);

console.log('Installing dependencies in tmp dir...');
execSync('npm install', { cwd: tmpDir, stdio: 'inherit' });
console.log('Compiling TypeScript...');
execSync('npx tsc', { cwd: tmpDir, stdio: 'inherit' });
console.log('Running deploy...\n');
execFileSync('node', ['dist/deploy.js'], {
  cwd: tmpDir, stdio: 'inherit', env: { ...process.env }
});
