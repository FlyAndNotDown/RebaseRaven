import { Resource, invoke } from "@tauri-apps/api/core";

export const activityApi = {
  reserve: async (id: string): Promise<Pick<Resource, "close">> => new Resource(await invoke<number>("reserve_activity", {id})),
  cancel: (id: string) => invoke<boolean>("cancel_activity", {id}),
};
