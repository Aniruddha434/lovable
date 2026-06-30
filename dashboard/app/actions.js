"use server";

import { redirect } from "next/navigation";
import { clearAdminCookie, requireAdmin } from "../lib/auth";
import { createLicense, deleteLicense, getLicense, saveLicense } from "../lib/store";

export async function createLicenseAction(formData) {
  await requireAdmin();
  await createLicense({
    owner: String(formData.get("owner") || ""),
    expires_at: String(formData.get("expires_at") || ""),
    status: String(formData.get("status") || "active"),
  });
  redirect("/");
}

export async function updateLicenseAction(formData) {
  await requireAdmin();
  const key = String(formData.get("key") || "").trim().toUpperCase();
  const license = await getLicense(key);
  if (license) {
    await saveLicense({
      ...license,
      owner: String(formData.get("owner") || ""),
      status: String(formData.get("status") || "active"),
      expires_at: String(formData.get("expires_at") || "") || null,
    });
  }
  redirect("/");
}

export async function resetDeviceAction(formData) {
  await requireAdmin();
  const key = String(formData.get("key") || "").trim().toUpperCase();
  const license = await getLicense(key);
  if (license) await saveLicense({ ...license, device_id: null, activated_at: null });
  redirect("/");
}

export async function deleteLicenseAction(formData) {
  await requireAdmin();
  await deleteLicense(String(formData.get("key") || ""));
  redirect("/");
}

export async function logoutAction() {
  await clearAdminCookie();
  redirect("/login");
}
