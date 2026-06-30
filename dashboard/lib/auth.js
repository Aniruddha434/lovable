import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const COOKIE_NAME = "mxx_admin";

function sessionValue() {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || "change-me";
}

export async function isAdmin() {
  const jar = await cookies();
  return jar.get(COOKIE_NAME)?.value === sessionValue();
}

export async function requireAdmin() {
  if (!(await isAdmin())) redirect("/login");
}

export async function setAdminCookie() {
  const jar = await cookies();
  jar.set(COOKIE_NAME, sessionValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearAdminCookie() {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}
