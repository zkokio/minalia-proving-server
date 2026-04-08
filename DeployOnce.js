"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VerificationEvent = exports.MinaliaVerifier = void 0;
exports.deployZkApp = deployZkApp;
const o1js_1 = require("o1js");
class VerificationEvent extends (0, o1js_1.Struct)({
    walletX: o1js_1.Field, walletY: o1js_1.Field,
    proofHashLow: o1js_1.Field, proofHashHigh: o1js_1.Field, dayTimestamp: o1js_1.Field,
}) {
}
exports.VerificationEvent = VerificationEvent;
class MinaliaVerifier extends o1js_1.SmartContract {
    constructor() {
        super(...arguments);
        this.totalVerifications = (0, o1js_1.State)();
        this.lastWalletX = (0, o1js_1.State)();
        this.lastProofHashLow = (0, o1js_1.State)();
        this.lastProofHashHigh = (0, o1js_1.State)();
        this.lastDayTimestamp = (0, o1js_1.State)();
        this.events = { verification: VerificationEvent };
    }
    init() {
        super.init();
        this.totalVerifications.set((0, o1js_1.Field)(0));
        this.lastWalletX.set((0, o1js_1.Field)(0));
        this.lastProofHashLow.set((0, o1js_1.Field)(0));
        this.lastProofHashHigh.set((0, o1js_1.Field)(0));
        this.lastDayTimestamp.set((0, o1js_1.Field)(0));
    }
    async recordVerification(walletPublicKey, proofHashLow, proofHashHigh, dayTimestamp) {
        const total = this.totalVerifications.getAndRequireEquals();
        this.totalVerifications.set(total.add((0, o1js_1.Field)(1)));
        this.lastWalletX.set(walletPublicKey.x);
        this.lastProofHashLow.set(proofHashLow);
        this.lastProofHashHigh.set(proofHashHigh);
        this.lastDayTimestamp.set(dayTimestamp);
        this.emitEvent('verification', new VerificationEvent({
            walletX: walletPublicKey.x,
            walletY: walletPublicKey.toGroup().y,
            proofHashLow, proofHashHigh, dayTimestamp,
        }));
    }
}
exports.MinaliaVerifier = MinaliaVerifier;
__decorate([
    (0, o1js_1.state)(o1js_1.Field),
    __metadata("design:type", Object)
], MinaliaVerifier.prototype, "totalVerifications", void 0);
__decorate([
    (0, o1js_1.state)(o1js_1.Field),
    __metadata("design:type", Object)
], MinaliaVerifier.prototype, "lastWalletX", void 0);
__decorate([
    (0, o1js_1.state)(o1js_1.Field),
    __metadata("design:type", Object)
], MinaliaVerifier.prototype, "lastProofHashLow", void 0);
__decorate([
    (0, o1js_1.state)(o1js_1.Field),
    __metadata("design:type", Object)
], MinaliaVerifier.prototype, "lastProofHashHigh", void 0);
__decorate([
    (0, o1js_1.state)(o1js_1.Field),
    __metadata("design:type", Object)
], MinaliaVerifier.prototype, "lastDayTimestamp", void 0);
__decorate([
    o1js_1.method,
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [o1js_1.PublicKey,
        o1js_1.Field,
        o1js_1.Field,
        o1js_1.Field]),
    __metadata("design:returntype", Promise)
], MinaliaVerifier.prototype, "recordVerification", null);
// Deploy function — called by Railway endpoint
async function deployZkApp(serverPrivKey) {
    const DEVNET = 'https://api.minascan.io/node/devnet/v1/graphql';
    const ARCHIVE = 'https://api.minascan.io/archive/devnet/v1/graphql';
    o1js_1.Mina.setActiveInstance(o1js_1.Mina.Network({ mina: DEVNET, archive: ARCHIVE }));
    const deployerKey = o1js_1.PrivateKey.fromBase58(serverPrivKey);
    const deployerPub = deployerKey.toPublicKey();
    const r = await (0, o1js_1.fetchAccount)({ publicKey: deployerPub });
    if (!r.account)
        throw new Error('Deployer account not found on devnet');
    const balance = Number(r.account.balance.toBigInt()) / 1e9;
    console.log('Balance:', balance, 'MINA');
    if (balance < 1)
        throw new Error('Need at least 1 MINA');
    const zkKey = o1js_1.PrivateKey.random();
    const zkPub = zkKey.toPublicKey();
    console.log('zkApp address:', zkPub.toBase58());
    console.log('Compiling MinaliaVerifier...');
    await MinaliaVerifier.compile();
    console.log('Compiled.');
    const zkApp = new MinaliaVerifier(zkPub);
    const tx = await o1js_1.Mina.transaction({ sender: deployerPub, fee: 100_000_000 }, async () => {
        o1js_1.AccountUpdate.fundNewAccount(deployerPub);
        await zkApp.deploy();
    });
    await tx.prove();
    tx.sign([deployerKey, zkKey]);
    const sent = await tx.send();
    return {
        txHash: sent.hash,
        zkAppAddress: zkPub.toBase58(),
        zkAppPrivateKey: zkKey.toBase58(),
        explorerUrl: 'https://minascan.io/devnet/tx/' + sent.hash,
    };
}
