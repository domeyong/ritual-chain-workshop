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

async function deployBounty(contractName = "AIJudge") {
  const connection = await network.create("hardhatMainnet");
  const { viem, networkHelpers } = connection;
  const walletClients = await viem.getWalletClients();
  const [owner, participant, otherParticipant] = walletClients;
  const publicClient = await viem.getPublicClient();
  const aiJudge = await viem.deployContract(contractName);
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
    publicClient,
    owner,
    participant,
    otherParticipant,
    walletClients,
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

  it("rejects copied commitments from another address", async () => {
    const { aiJudge, connection, networkHelpers, participant, otherParticipant } =
      await deployBounty();

    const answer = "Do not let another wallet steal this.";
    const salt = toHex("copy salt", { size: 32 });
    const commitment = commitmentFor(answer, salt, participant.account.address, 1n);

    await aiJudge.write.submitCommitment([1n, commitment], {
      account: participant.account,
    });
    await aiJudge.write.submitCommitment([1n, commitment], {
      account: otherParticipant.account,
    });

    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[4])),
    );

    await assert.rejects(
      aiJudge.write.revealAnswer([1n, answer, salt], {
        account: otherParticipant.account,
      }),
      /invalid reveal/,
    );

    await connection.close();
  });

  it("rejects a commitment reused for a different bounty", async () => {
    const { aiJudge, connection, networkHelpers, participant } =
      await deployBounty();

    const now = BigInt(await networkHelpers.time.latest());
    await aiJudge.write.createBounty(
      ["Second bounty", "Same answer should not reveal across bounties", now + 100n, now + 200n],
      { value: parseEther("1") },
    );

    const answer = "This only belongs to bounty one.";
    const salt = toHex("bounty salt", { size: 32 });
    const commitment = commitmentFor(answer, salt, participant.account.address, 1n);

    await aiJudge.write.submitCommitment([2n, commitment], {
      account: participant.account,
    });
    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([2n]).then((bounty) => bounty[4])),
    );

    await assert.rejects(
      aiJudge.write.revealAnswer([2n, answer, salt], {
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

  it("enforces answer length limits", async () => {
    const { aiJudge, connection, networkHelpers, participant, otherParticipant } =
      await deployBounty();

    const maxAnswer = "a".repeat(2_000);
    const tooLongAnswer = "b".repeat(2_001);
    const maxSalt = toHex("max salt", { size: 32 });
    const longSalt = toHex("long salt", { size: 32 });

    await aiJudge.write.submitCommitment(
      [1n, commitmentFor(maxAnswer, maxSalt, participant.account.address, 1n)],
      { account: participant.account },
    );
    await aiJudge.write.submitCommitment(
      [1n, commitmentFor(tooLongAnswer, longSalt, otherParticipant.account.address, 1n)],
      { account: otherParticipant.account },
    );

    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[4])),
    );

    await aiJudge.write.revealAnswer([1n, maxAnswer, maxSalt], {
      account: participant.account,
    });

    await assert.rejects(
      aiJudge.write.revealAnswer([1n, tooLongAnswer, longSalt], {
        account: otherParticipant.account,
      }),
      /answer too long/,
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

  it("enforces max submissions", async () => {
    const { aiJudge, connection, walletClients } = await deployBounty();

    for (let i = 1; i <= 10; i++) {
      const participant = walletClients[i];
      const salt = toHex(`salt ${i}`, { size: 32 });
      const answer = `answer ${i}`;
      const commitment = commitmentFor(answer, salt, participant.account.address, 1n);
      await aiJudge.write.submitCommitment([1n, commitment], {
        account: participant.account,
      });
    }

    const extra = walletClients[11];
    const extraSalt = toHex("extra salt", { size: 32 });
    const extraCommitment = commitmentFor(
      "extra answer",
      extraSalt,
      extra.account.address,
      1n,
    );

    await assert.rejects(
      aiJudge.write.submitCommitment([1n, extraCommitment], {
        account: extra.account,
      }),
      /too many submissions/,
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

  it("blocks early judging, empty LLM input, and cancelling after a valid reveal", async () => {
    const { aiJudge, connection, networkHelpers, participant } =
      await deployBounty();

    const answer = "This valid answer should force judging, not cancellation.";
    const salt = toHex("judge salt", { size: 32 });
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

    await assert.rejects(
      aiJudge.write.judgeAll([1n, "0x1234"]),
      /reveal not closed/,
    );

    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[5])),
    );

    await assert.rejects(aiJudge.write.judgeAll([1n, "0x"]), /empty llm input/);
    await assert.rejects(aiJudge.write.cancelBounty([1n]), /has revealed answers/);

    await connection.close();
  });

  it("blocks non-owners from judging, finalizing, or cancelling", async () => {
    const { aiJudge, connection, networkHelpers, participant, otherParticipant } =
      await deployBounty("TestableAIJudge");

    const answer = "Only owner can control final state.";
    const salt = toHex("owner salt", { size: 32 });
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
    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[5])),
    );

    await assert.rejects(
      aiJudge.write.judgeAll([1n, "0x1234"], {
        account: otherParticipant.account,
      }),
      /not bounty owner/,
    );

    await aiJudge.write.forceJudgedForTest([1n, toHex("AI review")]);

    await assert.rejects(
      aiJudge.write.finalizeWinner([1n, 0n], {
        account: otherParticipant.account,
      }),
      /not bounty owner/,
    );

    await assert.rejects(
      aiJudge.write.cancelBounty([1n], {
        account: otherParticipant.account,
      }),
      /not bounty owner/,
    );

    await connection.close();
  });

  it("pays exactly one revealed winner and blocks invalid winners", async () => {
    const { aiJudge, connection, networkHelpers, publicClient, participant, otherParticipant } =
      await deployBounty("TestableAIJudge");

    const revealedAnswer = "Pay this revealed participant.";
    const revealedSalt = toHex("pay salt", { size: 32 });
    const hiddenAnswer = "This one never reveals.";
    const hiddenSalt = toHex("hidden winner salt", { size: 32 });

    await aiJudge.write.submitCommitment(
      [1n, commitmentFor(revealedAnswer, revealedSalt, participant.account.address, 1n)],
      { account: participant.account },
    );
    await aiJudge.write.submitCommitment(
      [1n, commitmentFor(hiddenAnswer, hiddenSalt, otherParticipant.account.address, 1n)],
      { account: otherParticipant.account },
    );

    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[4])),
    );
    await aiJudge.write.revealAnswer([1n, revealedAnswer, revealedSalt], {
      account: participant.account,
    });
    await networkHelpers.time.increaseTo(
      Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[5])),
    );
    await aiJudge.write.forceJudgedForTest([1n, toHex("AI review")]);

    await assert.rejects(aiJudge.write.finalizeWinner([1n, 99n]), /invalid winner/);
    await assert.rejects(
      aiJudge.write.finalizeWinner([1n, 1n]),
      /winner not revealed/,
    );

    const before = await publicClient.getBalance({
      address: participant.account.address,
    });

    await aiJudge.write.finalizeWinner([1n, 0n]);

    const after = await publicClient.getBalance({
      address: participant.account.address,
    });
    const bounty = await aiJudge.read.getBounty([1n]);

    assert.equal(after - before, parseEther("1"));
    assert.equal(bounty[3], 0n);
    assert.equal(bounty[7], true);
    assert.equal(bounty[9], 0n);

    await assert.rejects(
      aiJudge.write.finalizeWinner([1n, 0n]),
      /already finalized/,
    );

    await connection.close();
  });

  it("survives 50 randomized commit-reveal payout and cancel scenarios", async () => {
    for (let round = 0; round < 50; round++) {
      const {
        aiJudge,
        connection,
        networkHelpers,
        publicClient,
        walletClients,
      } = await deployBounty("TestableAIJudge");

      const participantCount = 1 + (round % 10);
      const revealModulo = 2 + (round % 3);
      const revealedIndexes: number[] = [];

      for (let i = 0; i < participantCount; i++) {
        const participant = walletClients[i + 1];
        const answer = `round ${round} answer ${i}`;
        const salt = toHex(`round ${round} salt ${i}`, { size: 32 });
        const commitment = commitmentFor(
          answer,
          salt,
          participant.account.address,
          1n,
        );

        await aiJudge.write.submitCommitment([1n, commitment], {
          account: participant.account,
        });
      }

      await networkHelpers.time.increaseTo(
        Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[4])),
      );

      for (let i = 0; i < participantCount; i++) {
        if ((i + round) % revealModulo !== 0) {
          continue;
        }

        const participant = walletClients[i + 1];
        const answer = `round ${round} answer ${i}`;
        const salt = toHex(`round ${round} salt ${i}`, { size: 32 });

        await aiJudge.write.revealAnswer([1n, answer, salt], {
          account: participant.account,
        });

        revealedIndexes.push(i);
      }

      await networkHelpers.time.increaseTo(
        Number(await aiJudge.read.bounties([1n]).then((bounty) => bounty[5])),
      );

      if (revealedIndexes.length === 0) {
        await aiJudge.write.cancelBounty([1n]);

        const bounty = await aiJudge.read.getBounty([1n]);
        assert.equal(bounty[3], 0n);
        assert.equal(bounty[6], false);
        assert.equal(bounty[7], true);
      } else {
        await aiJudge.write.forceJudgedForTest([1n, toHex(`AI review ${round}`)]);

        const winnerIndex = revealedIndexes[round % revealedIndexes.length];
        const winner = walletClients[winnerIndex + 1];
        const before = await publicClient.getBalance({
          address: winner.account.address,
        });

        await aiJudge.write.finalizeWinner([1n, BigInt(winnerIndex)]);

        const after = await publicClient.getBalance({
          address: winner.account.address,
        });
        const bounty = await aiJudge.read.getBounty([1n]);

        assert.equal(after - before, parseEther("1"));
        assert.equal(bounty[3], 0n);
        assert.equal(bounty[6], true);
        assert.equal(bounty[7], true);
        assert.equal(bounty[9], BigInt(winnerIndex));
      }

      await connection.close();
    }
  });
});
