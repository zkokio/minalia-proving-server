/**
 * MinaliaVerifier zkApp
 * 
 * On-chain smart contract that stores wallet verification proof hashes.
 * When a player verifies their wallet, the proof hash is stored on Mina mainnet.
 * Anyone can verify independently by checking the on-chain state.
 * 
 * On-chain state (8 Field slots available):
 *   - totalVerifications: count of all verifications
 *   - lastProofHash (low):  lower 128 bits of most recent proof hash
 *   - lastProofHash (high): upper 128 bits of most recent proof hash  
 *   - lastTimestamp: day timestamp of most recent verification
 * 
 * Events emitted per verification (queryable via Mina GraphQL):
 *   - { walletX, walletY, proofHashLow, proofHashHigh, dayTimestamp }
 */

import {
  SmartContract, state, State, method, Field, PublicKey,
  Poseidon, UInt64, CircuitString, Provable, Bool,
  AccountUpdate, ZkProgram, Struct, Mina, PrivateKey
} from 'o1js';

// Event emitted for each verification — queryable on-chain
class VerificationEvent extends Struct({
  walletX:       Field,   // wallet public key x coordinate
  walletY:       Field,   // wallet public key y coordinate  
  proofHashLow:  Field,   // lower half of proof hash
  proofHashHigh: Field,   // upper half of proof hash
  dayTimestamp:  Field,   // day of verification
}) {}

export class MinaliaVerifier extends SmartContract {
  // On-chain state
  @state(Field) totalVerifications = State();
  @state(Field) lastWalletX        = State();
  @state(Field) lastProofHashLow   = State();
  @state(Field) lastProofHashHigh  = State();
  @state(Field) lastDayTimestamp   = State();

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
    walletPublicKey: PublicKey,
    proofHashLow:    Field,
    proofHashHigh:   Field,
    dayTimestamp:    Field,
    serverKey:       PublicKey,
  ) {
    // Read current state
    const total = this.totalVerifications.getAndRequireEquals();

    // Update state
    this.totalVerifications.set(total.add(1));
    this.lastWalletX.set(walletPublicKey.x);
    this.lastProofHashLow.set(proofHashLow);
    this.lastProofHashHigh.set(proofHashHigh);
    this.lastDayTimestamp.set(dayTimestamp);

    // Emit event — this is what makes it queryable on-chain
    this.emitEvent('verification', new VerificationEvent({
      walletX:      walletPublicKey.x,
      walletY:      walletPublicKey.toGroup().y,
      proofHashLow,
      proofHashHigh,
      dayTimestamp,
    }));
  }
}
