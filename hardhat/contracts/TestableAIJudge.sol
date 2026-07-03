// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AIJudge} from "./AIJudge.sol";

contract TestableAIJudge is AIJudge {
    function forceJudgedForTest(
        uint256 bountyId,
        bytes calldata aiReview
    ) external {
        Bounty storage bounty = bounties[bountyId];
        require(bounty.owner != address(0), "bounty not found");
        bounty.judged = true;
        bounty.aiReview = aiReview;
    }
}
