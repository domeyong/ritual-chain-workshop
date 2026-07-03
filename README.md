# Privacy-Preserving AI Bounty Judge

This submission updates the workshop bounty judge with a commit-reveal flow so answers are not public during the submission phase.

## What Changed

- `AIJudge.sol` now uses `submitCommitment(uint256 bountyId, bytes32 commitment)` instead of public answer submission.
- Participants reveal later with `revealAnswer(uint256 bountyId, string calldata answer, bytes32 salt)`.
- The contract verifies `keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))`.
- Only revealed, valid answers can win.
- `judgeAll(uint256 bountyId, bytes calldata llmInput)` can run only after the reveal deadline.
- `finalizeWinner(uint256 bountyId, uint256 winnerIndex)` can pay only a revealed submission after judging.
- `cancelBounty(uint256 bountyId)` lets the owner recover the reward after the reveal deadline if nobody revealed a valid answer.

## Bounty Lifecycle

1. The bounty owner calls `createBounty(title, rubric, submissionDeadline, revealDeadline)` and sends the reward.
2. Before the submission deadline, each participant creates a private salt and computes:

```solidity
bytes32 commitment = keccak256(
    abi.encodePacked(answer, salt, msg.sender, bountyId)
);
```

3. The participant calls `submitCommitment(bountyId, commitment)`.
4. The answer stays hidden because only the hash is stored on-chain.
5. After the submission deadline, the participant calls `revealAnswer(bountyId, answer, salt)`.
6. The contract checks that the reveal matches the original commitment.
7. After the reveal deadline, the owner sends all valid revealed answers in one batch to Ritual AI through `judgeAll`.
8. After judging, the owner calls `finalizeWinner` to pay one winner.

## Required Rules Covered

- Commitments are accepted only before the submission deadline.
- Reveals are accepted only after the submission deadline and before the reveal deadline.
- One address can submit only one commitment per bounty.
- Wrong answers or wrong salts cannot reveal another commitment.
- Unrevealed submissions are not eligible for the reward.
- Empty answers are rejected during reveal.
- Judging is blocked until the reveal phase is closed.
- Finalization is blocked until judging is complete.
- If nobody reveals, the owner can cancel the bounty and recover the locked reward.

## Test Plan

Implemented tests are in `hardhat/test/AIJudge.ts`. `hardhat/contracts/TestableAIJudge.sol` is a test helper used only to verify payout behavior after judging.

- Valid reveal: submit a commitment, wait until reveal phase, reveal the matching answer and salt.
- Invalid reveal: submit a commitment, reveal with the wrong salt, expect revert.
- Copied commitment: another address cannot reveal a copied commitment.
- Cross-bounty replay: a commitment for one bounty cannot reveal on another bounty.
- Empty reveal: submit a commitment for an empty answer, reveal it, expect revert.
- Answer length: 2,000 bytes is accepted and 2,001 bytes is rejected.
- Timing and duplicate protection: reject duplicate commitment, reject reveal before the reveal phase, reject late or repeated reveal.
- Submission cap: the 11th commitment is rejected when the bounty already has 10 submissions.
- No valid reveals: after the reveal deadline, owner can cancel and recover the reward.
- Owner-only controls: non-owners cannot judge, finalize, or cancel.
- Judging safety: judging is blocked before the reveal deadline and empty LLM input is rejected.
- Payout safety: invalid winners and unrevealed winners are rejected, one revealed winner is paid once, and repeat finalization is blocked.
- Randomized regression: 50 commit-reveal rounds cover different participant counts, reveal sets, payout winners, and no-reveal cancellations.

Run:

```shell
cd hardhat
pnpm install
pnpm approve-builds --all
pnpm exec hardhat test
```

## Architecture Note

The required commit-reveal version is simple and works on any EVM chain. During the submission phase, the chain stores only commitments, so other participants cannot copy plaintext answers. During the reveal phase, answers become public before AI judging, which is acceptable for the required track but still not fully private.

For a Ritual-native hidden submission design, participants would encrypt answers for a Ritual TEE executor and store only encrypted blobs or storage references on-chain. Plaintext answers would exist only inside the participant's device before upload and inside the Ritual TEE during judging. The LLM should receive all decrypted submissions together as one batch, not one request per answer. After judging, the system can publish a revealed answer bundle off-chain, such as IPFS, and store `revealedAnswersRef` plus `revealedAnswersHash` on-chain so everyone can verify the final bundle.

Example advanced output:

```json
{
  "winnerIndex": 2,
  "ranking": [
    {
      "index": 2,
      "score": 94,
      "reason": "Best satisfies the rubric."
    }
  ],
  "revealedAnswersRef": "ipfs://...",
  "revealedAnswersHash": "0x...",
  "summary": "Submission 2 is the strongest answer."
}
```

## Reflection

The bounty title, rubric, reward, deadlines, commitments, reveal status, judge result, and final winner should be public because they are needed for trust and auditability. The actual answers should stay hidden during the submission phase so later participants cannot copy earlier work. Salts should stay private until reveal, because the salt is what prevents people from guessing or reusing a commitment. AI should compare submissions against the rubric, summarize strengths and weaknesses, and recommend a ranking. A human bounty owner should make the final payout decision because AI output can be wrong, biased, malformed, or misread. The contract should enforce deadlines, eligibility, and payment rules because those are objective rules. The best bounty system uses AI for evaluation support, humans for accountability, and smart contracts for transparent enforcement.
