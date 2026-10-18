import { invoke } from "@tauri-apps/api/core";

export interface DshCurrentState {
  providerIds: string[];
  currentProviderId: string | null;
  currentModel: string | null;
}

/** DSH 中某个 provider 的地址快照（原始直连 ↔ 本机中转）。 */
export interface DshRelayProvider {
  providerId: string;
  name: string;
  originalBaseUrl: string | null;
  relayBaseUrl: string | null;
  relayed: boolean;
}

/** `dsh_relay_status` 的返回：开关状态 + 中转是否已写好 + 各 provider 地址。 */
export interface DshRelayStatus {
  relayEnabled: boolean;
  restoreOnExit: boolean;
  attached: boolean;
  baseUrl: string | null;
  providers: DshRelayProvider[];
}

export const dshApi = {
  async getCurrentState(): Promise<DshCurrentState> {
    return await invoke("get_dsh_current_state");
  },

  async setCurrentModel(providerId: string, modelId: string): Promise<boolean> {
    return await invoke("set_dsh_current_model", { providerId, modelId });
  },

  async getRelayStatus(): Promise<DshRelayStatus> {
    return await invoke("dsh_relay_status");
  },

  async setRelay(enabled: boolean): Promise<DshRelayStatus> {
    return await invoke("dsh_set_relay", { enabled });
  },

  async setRestoreOnExit(enabled: boolean): Promise<DshRelayStatus> {
    return await invoke("dsh_set_restore_on_exit", { enabled });
  },
};
