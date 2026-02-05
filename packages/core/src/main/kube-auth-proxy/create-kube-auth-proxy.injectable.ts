/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { loggerInjectionToken } from "@freelensapp/logger";
import { getInjectable, lifecycleEnum } from "@ogre-tools/injectable";
import assert from "assert";
import { observable, when } from "mobx";
import { TypedRegEx } from "typed-regex";
import getDirnameOfPathInjectable from "../../common/path/get-dirname.injectable";
import randomBytesInjectable from "../../common/utils/random-bytes.injectable";
import clusterApiUrlInjectable from "../../features/cluster/connections/main/api-url.injectable";
import spawnInjectable from "../child-process/spawn.injectable";
import broadcastConnectionUpdateInjectable from "../cluster/broadcast-connection-update.injectable";
import getPortFromStreamInjectable from "../utils/get-port-from-stream.injectable";
import freeLensK8sProxyPathInjectable from "./freelens-k8s-proxy-path.injectable";
import kubeAuthProxyCertificateInjectable from "./kube-auth-proxy-certificate.injectable";
import waitUntilPortIsUsedInjectable from "./wait-until-port-is-used/wait-until-port-is-used.injectable";
import type { ChildProcess } from "child_process";

import type { Cluster } from "../../common/cluster/cluster";

export interface KubeAuthProxy {
  readonly apiPrefix: string;
  readonly port: number;
  run: () => Promise<void>;
  exit: () => void;
  resetRetryCount: () => void;
}

export type CreateKubeAuthProxy = (env: NodeJS.ProcessEnv) => KubeAuthProxy;

const startingServeMatcher = "starting to serve on (?<address>.+)";
const startingServeRegex = Object.assign(TypedRegEx(startingServeMatcher, "i"), {
  rawMatcher: startingServeMatcher,
});

// Configuration for retry logic
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const MAX_RETRY_DELAY_MS = 30000; // 30 seconds

const createKubeAuthProxyInjectable = getInjectable({
  id: "create-kube-auth-proxy",

  instantiate: (di, cluster): CreateKubeAuthProxy => {
    const freeLensK8sProxyPath = di.inject(freeLensK8sProxyPathInjectable);
    const spawn = di.inject(spawnInjectable);
    const logger = di.inject(loggerInjectionToken);
    const waitUntilPortIsUsed = di.inject(waitUntilPortIsUsedInjectable);
    const getPortFromStream = di.inject(getPortFromStreamInjectable);
    const getDirnameOfPath = di.inject(getDirnameOfPathInjectable);
    const randomBytes = di.inject(randomBytesInjectable);
    const clusterApiUrl = di.inject(clusterApiUrlInjectable, cluster);
    const broadcastConnectionUpdate = di.inject(broadcastConnectionUpdateInjectable, cluster);

    return (env) => {
      let port: number | undefined;
      let proxyProcess: ChildProcess | undefined;
      const ready = observable.box(false);
      const apiPrefix = `/${randomBytes(8).toString("hex")}`;
      let retryCount = 0;

      const exit = () => {
        ready.set(false);

        if (proxyProcess) {
          logger.debug("[KUBE-AUTH]: stopping local proxy", cluster.getMeta());
          proxyProcess.removeAllListeners();
          proxyProcess.stderr?.removeAllListeners();
          proxyProcess.stdout?.removeAllListeners();
          proxyProcess.kill();
          proxyProcess = undefined;
        }
      };

      const resetRetryCount = () => {
        retryCount = 0;
        logger.debug("[KUBE-AUTH-PROXY]: retry count reset", cluster.getMeta());
      };

      const calculateRetryDelay = (): number => {
        // Exponential backoff: delay = min(INITIAL_DELAY * 2^retryCount, MAX_DELAY)
        const delay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount), MAX_RETRY_DELAY_MS);
        return delay;
      };

      const shouldRetry = (): boolean => {
        return retryCount < MAX_RETRY_ATTEMPTS;
      };

      const waitBeforeRetry = async (): Promise<void> => {
        const delay = calculateRetryDelay();
        logger.info(
          `[KUBE-AUTH-PROXY]: waiting ${delay}ms before retry attempt ${retryCount + 1}/${MAX_RETRY_ATTEMPTS}`,
          cluster.getMeta(),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      };

      const run = async (): Promise<void> => {
        if (proxyProcess) {
          return when(() => ready.get());
        }

        const apiUrl = await clusterApiUrl();
        const certificate = di.inject(kubeAuthProxyCertificateInjectable, apiUrl.hostname);

        proxyProcess = spawn(freeLensK8sProxyPath, [], {
          env: {
            ...env,
            KUBECONFIG: cluster.kubeConfigPath.get(),
            KUBECONFIG_CONTEXT: cluster.contextName.get(),
            API_PREFIX: apiPrefix,
            PROXY_KEY: certificate.private,
            PROXY_CERT: certificate.cert,
          },
          cwd: getDirnameOfPath(cluster.kubeConfigPath.get()),
        });
        proxyProcess.on("error", (error) => {
          broadcastConnectionUpdate({
            level: "error",
            message: error.message,
          });
          exit();
        });

        proxyProcess.on("exit", (code) => {
          if (code) {
            broadcastConnectionUpdate({
              level: "error",
              message: `proxy exited with code: ${code}`,
            });
          } else {
            broadcastConnectionUpdate({
              level: "info",
              message: "proxy exited successfully",
            });
          }
          exit();
        });

        proxyProcess.on("disconnect", () => {
          broadcastConnectionUpdate({
            level: "error",
            message: "Proxy disconnected communications",
          });
          exit();
        });

        assert(proxyProcess.stderr);
        assert(proxyProcess.stdout);

        proxyProcess.stderr.on("data", (data: Buffer) => {
          if (data.includes("http: TLS handshake error")) {
            return;
          }

          broadcastConnectionUpdate({
            level: "error",
            message: data.toString(),
          });
        });

        proxyProcess.stdout.on("data", (data: Buffer) => {
          if (typeof port === "number") {
            broadcastConnectionUpdate({
              level: "info",
              message: data.toString(),
            });
          }
        });

        try {
          port = await getPortFromStream(proxyProcess.stdout, {
            lineRegex: startingServeRegex,
            onFind: () =>
              broadcastConnectionUpdate({
                level: "info",
                message: "Authentication proxy started",
              }),
          });
          // Reset retry count on successful start
          resetRetryCount();
        } catch (error) {
          logger.warn("[KUBE-AUTH-PROXY]: getPortFromStream failed", error);
          exit();

          if (shouldRetry()) {
            retryCount++;
            broadcastConnectionUpdate({
              level: "error",
              message: `Proxy port can't be found, retrying (${retryCount}/${MAX_RETRY_ATTEMPTS})...`,
            });
            await waitBeforeRetry();
            return run();
          } else {
            broadcastConnectionUpdate({
              level: "error",
              message:
                "Proxy failed to start after maximum retry attempts. Please check your authentication and try reconnecting.",
            });
            throw new Error("Proxy startup failed after maximum retry attempts");
          }
        }

        logger.info(`[KUBE-AUTH-PROXY]: found port=${port}`);

        try {
          await waitUntilPortIsUsed(port, 500, 10000);
          ready.set(true);
          // Reset retry count on successful connection
          resetRetryCount();
        } catch (error) {
          logger.warn("[KUBE-AUTH-PROXY]: waitUntilUsed failed", error);
          exit();

          if (shouldRetry()) {
            retryCount++;
            broadcastConnectionUpdate({
              level: "error",
              message: `Proxy port failed to be used within time limit, retrying (${retryCount}/${MAX_RETRY_ATTEMPTS})...`,
            });
            await waitBeforeRetry();
            return run();
          } else {
            broadcastConnectionUpdate({
              level: "error",
              message:
                "Proxy failed to connect after maximum retry attempts. Please check your authentication and try reconnecting.",
            });
            throw new Error("Proxy connection failed after maximum retry attempts");
          }
        }
      };

      return {
        apiPrefix,
        exit,
        run,
        resetRetryCount,
        get port() {
          assert(port, "port has not yet been initialized");

          return port;
        },
      };
    };
  },
  lifecycle: lifecycleEnum.keyedSingleton({
    getInstanceKey: (di, cluster: Cluster) => cluster.id,
  }),
});

export default createKubeAuthProxyInjectable;
