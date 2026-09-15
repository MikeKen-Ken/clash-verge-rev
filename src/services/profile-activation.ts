import { invoke } from "@tauri-apps/api/core";
import { mutate } from "swr";

export type ProfileUpdateOutcome =
  | "skipped"
  | "downloadSucceeded"
  | "downloadFailed"
  | "applied"
  | "activationFailed";
export interface ProfileActivationStatus {
  uid: string;
  outcome: ProfileUpdateOutcome;
  lastAppliedAt: number | null;
}
export const getProfileActivation = () =>
  invoke<ProfileActivationStatus | null>("get_profile_activation");

export function checkProfileOutcome(outcome: ProfileUpdateOutcome) {
  if (outcome === "downloadFailed")
    throw new Error("Subscription download failed.");
  if (outcome === "activationFailed") {
    throw new Error(
      "Subscription downloaded, but activation failed. Retry activation on the Profiles page.",
    );
  }
}

export async function retryProfileActivation(index: string) {
  try {
    checkProfileOutcome(
      await invoke<ProfileUpdateOutcome>("retry_profile_activation", { index }),
    );
  } finally {
    await mutate("profileActivation");
  }
}
