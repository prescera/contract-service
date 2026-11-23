// Copyright (c) iSPIRT Foundation.
// Licensed under the MIT license.
//
// DEPA Training v2 contract service — CCF JavaScript application entry point.
// Every export is referenced by a "js_function" in app.json.

import { receiptEndpoint } from "../packages/depa-ccf-common/src/index";
import { getCatalogEntry, getCatalogVersion, listCatalog, publishDataset } from "./catalog";
import { getContract, listContracts, proposeContract, revokeContract, signContract } from "./contracts";
import { authorizeRun, getRun, listRuns, postRunEvent, refreshRat } from "./runs";
import { governance, info } from "./service";

const gov = governance.endpoints;

export {
  info,
  receiptEndpoint as receipt,
  publishDataset,
  listCatalog,
  getCatalogEntry,
  getCatalogVersion,
  proposeContract,
  listContracts,
  getContract,
  signContract,
  revokeContract,
  authorizeRun,
  listRuns,
  postRunEvent,
  refreshRat,
  getRun,
};

export const govBootstrap = gov.bootstrap;
export const govPropose = gov.propose;
export const govVote = gov.vote;
export const govListProposals = gov.listProposals;
export const govGetProposal = gov.getProposal;
export const govMembers = gov.members;
export const govConstitution = gov.constitution;
export const govState = gov.state;
export const listParties = gov.listParties;
export const getParty = gov.getParty;
export const listReleases = gov.listReleases;
export const getRelease = gov.getRelease;
