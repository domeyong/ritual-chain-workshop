import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodePacked, keccak256, parseEther, toHex } from "viem";

function commitmentFor(
  answer: string,
  salt: `0x${string}`,
  submitter: `0x${string}`,
  bountyId: bigint,
) {
  return keccak256(
    encodePacked(
      ["string", "bytes32", "address", "uint256"],
      [answer, salt, submitter, bountyId],
    ),
  );
}

async function deployBounty() {
  const connection = await network.create("hardhatMainnet");
  const { viem, networkHelpers } = connection;
  const [owner, participant, otherParticipant] = await viem.getWalletClients();
  const aiJudge = await viem.deployContract("AIJudge");
  const now = BigInt(await networkHelpers.time.latest());
  const submissionDeadline = now + 100n;
  const revealDeadline = now + 200n;

  await aiJudge.write.createBounty(
    ["Private AI bounty", "Pick the clearest useful answer", submissionDeadline, revealDeadline],
    { value: parseEther("1") },
  );

  return {
    aiJudge,
    connection,
    networkHelpers,
    owner,
    participant,
    otherParticipant,
    submissionDeadline,
    revealDeadline,
  };
}

describe("AIJudge commit-reveal flow", () => {
  it("accepts a valid reveal after the submission deadline", async () => {
    const { aiJudge, connection, networkHelpers, participant } =
      await deployBounty();

    const answer = "Use a batch LLM review with hidden answers.";
    const salt = toHex("secret salt", { size: 32 });
    const commitment = commitmentFor(answer, salt, participant.account.address, 1n);

    await aiJudge.write.submitCommitment([1n, commitment], {
      account: participant.account,
    });

    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[4])),
    );

    await aiJudge.write.revealAnswer([1n, answer, salt], {
      account: participant.account,
    });

    const submission = await aiJudge.read.getSubmission([1n, 0n]);
    const status = await aiJudge.read.getSubmissionStatus([1n, 0n]);

    assert.equal(submission[0].toLowerCase(), participant.account.address.toLowerCase());
    assert.equal(submission[1], answer);
    assert.equal(status[2], true);

    await connection.close();
  });

  it("rejects a reveal with the wrong salt", async () => {
    const { aiJudge, connection, networkHelpers, participant } =
      await deployBounty();

    const answer = "A correct answer.";
    const salt = toHex("real salt", { size: 32 });
    const wrongSalt = toHex("wrong salt", { size: 32 });
    const commitment = commitmentFor(answer, salt, participant.account.address, 1n);

    await aiJudge.write.submitCommitment([1n, commitment], {
      account: participant.account,
    });
    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[4])),
    );

    await assert.rejects(
      aiJudge.write.revealAnswer([1n, answer, wrongSalt], {
        account: participant.account,
      }),
      /invalid reveal/,
    );

    await connection.close();
  });

  it("rejects an empty revealed answer", async () => {
    const { aiJudge, connection, networkHelpers, participant } =
      await deployBounty();

    const answer = "";
    const salt = toHex("empty salt", { size: 32 });
    const commitment = commitmentFor(answer, salt, participant.account.address, 1n);

    await aiJudge.write.submitCommitment([1n, commitment], {
      account: participant.account,
    });
    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[4])),
    );

    await assert.rejects(
      aiJudge.write.revealAnswer([1n, answer, salt], {
        account: participant.account,
      }),
      /empty answer/,
    );

    await connection.close();
  });

  it("enforces one commitment per participant and reveal timing", async () => {
    const { aiJudge, connection, networkHelpers, participant } =
      await deployBounty();

    const answer = "Timing matters.";
    const salt = toHex("timing salt", { size: 32 });
    const commitment = commitmentFor(answer, salt, participant.account.address, 1n);

    await aiJudge.write.submitCommitment([1n, commitment], {
      account: participant.account,
    });

    await assert.rejects(
      aiJudge.write.submitCommitment([1n, commitment], {
        account: participant.account,
      }),
      /already committed/,
    );

    await assert.rejects(
      aiJudge.write.revealAnswer([1n, answer, salt], {
        account: participant.account,
      }),
      /reveal not open/,
    );

    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[4])),
    );
    await aiJudge.write.revealAnswer([1n, answer, salt], {
      account: participant.account,
    });

    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[5])),
    );

    await assert.rejects(
      aiJudge.write.revealAnswer([1n, answer, salt], {
        account: participant.account,
      }),
      /reveal closed|already revealed/,
    );

    await connection.close();
  });

  it("lets the owner cancel and recover the reward when nobody reveals", async () => {
    const { aiJudge, connection, networkHelpers, participant } =
      await deployBounty();

    const answer = "I will not reveal this.";
    const salt = toHex("hidden salt", { size: 32 });
    const commitment = commitmentFor(answer, salt, participant.account.address, 1n);

    await aiJudge.write.submitCommitment([1n, commitment], {
      account: participant.account,
    });

    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[5])),
    );

    await aiJudge.write.cancelBounty([1n]);

    const bounty = await aiJudge.read.getBounty([1n]);

    assert.equal(bounty[3], 0n);
    assert.equal(bounty[7], true);

    await connection.close();
  });
});
