// Copyright (c) iSPIRT Foundation.
// Licensed under the MIT license.

import { createGovernance, makeInfoEndpoint, ServiceDescriptor } from "../packages/depa-ccf-common/src/index";
import { APP_VERSION, BUNDLE_DIGEST } from "./build_info";
import { PEER_NAME, SERVICE_NAME } from "./constants";
import { contractGovernanceActions } from "./contracts";

export const SERVICE: ServiceDescriptor = {
  name: SERVICE_NAME,
  version: APP_VERSION,
  bundleDigest: BUNDLE_DIGEST,
  peerName: PEER_NAME,
  actions: [...contractGovernanceActions],
};

export const governance = createGovernance(SERVICE);

export const info = makeInfoEndpoint(SERVICE);
