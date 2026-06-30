import { redirect } from "next/navigation";
import { isAdmin, setAdminCookie } from "../../lib/auth";

async function login(formData) {
  "use server";
  const password = String(formData.get("password") || "");
  if (password !== process.env.ADMIN_PASSWORD) redirect("/login?error=1");
  await setAdminCookie();
  redirect("/");
}

export default async function LoginPage({ searchParams }) {
  if (await isAdmin()) redirect("/");
  const params = await searchParams;
  return (
    <main className="login">
      <form className="card" action={login}>
        <p className="eyebrow">Admin</p>
        <h1>Dashboard Login</h1>
        <p className="sub">Use your `ADMIN_PASSWORD` from Vercel environment variables.</p>
        <div className="field">
          <label>Password</label>
          <input type="password" name="password" required autoFocus />
        </div>
        {params?.error ? <p style={{ color: "#fca5a5" }}>Invalid password.</p> : null}
        <button type="submit">Login</button>
      </form>
    </main>
  );
}
