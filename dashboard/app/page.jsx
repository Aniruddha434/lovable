import { requireAdmin } from "../lib/auth";
import { listEvents, listLicenses, listUploads } from "../lib/store";
import { createLicenseAction, deleteLicenseAction, logoutAction, resetDeviceAction, updateLicenseAction } from "./actions";

function toLocalInput(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 16);
}

export default async function DashboardPage() {
  await requireAdmin();
  const [licenses, events, uploads] = await Promise.all([listLicenses(), listEvents(12), listUploads(12)]);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://your-vercel-domain.vercel.app";

  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Lovable Extension</p>
          <h1>License Dashboard</h1>
          <p className="sub">Create keys, bind one device per key, receive extension validation calls, track events, and upload files through your Vercel backend.</p>
          <p className="notice">Extension API base: <code>{baseUrl}</code></p>
        </div>
        <form action={logoutAction}><button className="secondary">Logout</button></form>
      </section>

      <section className="grid">
        <form className="card" action={createLicenseAction}>
          <h2>Create License</h2>
          <div className="field"><label>Owner</label><input name="owner" placeholder="Customer name or email" /></div>
          <div className="field"><label>Status</label><select name="status" defaultValue="active"><option>active</option><option>paused</option><option>revoked</option></select></div>
          <div className="field"><label>Expires At</label><input type="datetime-local" name="expires_at" /></div>
          <button type="submit">Generate Key</button>
          <p className="notice">One key locks to the first device that validates it. Use reset device to move a customer.</p>
        </form>

        <div className="card">
          <h2>Licenses</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Key</th><th>Owner</th><th>Status</th><th>Expires</th><th>Device</th><th>Actions</th></tr></thead>
              <tbody>
                {licenses.map((license) => (
                  <tr key={license.key}>
                    <td><code>{license.key}</code></td>
                    <td>
                      <form id={`u-${license.key}`} action={updateLicenseAction}>
                        <input type="hidden" name="key" value={license.key} />
                        <input name="owner" defaultValue={license.owner || ""} />
                      </form>
                    </td>
                    <td><select name="status" form={`u-${license.key}`} defaultValue={license.status || "active"}><option>active</option><option>paused</option><option>revoked</option></select></td>
                    <td><input type="datetime-local" name="expires_at" form={`u-${license.key}`} defaultValue={toLocalInput(license.expires_at)} /></td>
                    <td>{license.device_id ? <code>{String(license.device_id).slice(0, 18)}...</code> : <span className="notice">Not bound</span>}</td>
                    <td>
                      <div className="button-row">
                        <button type="submit" form={`u-${license.key}`}>Save</button>
                        <form action={resetDeviceAction}><input type="hidden" name="key" value={license.key} /><button className="secondary">Reset</button></form>
                        <form action={deleteLicenseAction}><input type="hidden" name="key" value={license.key} /><button className="danger">Delete</button></form>
                      </div>
                    </td>
                  </tr>
                ))}
                {!licenses.length ? <tr><td colSpan="6" className="notice">No licenses yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 18 }}>
        <div className="card"><h2>Recent Events</h2>{events.map((e) => <p className="notice" key={e.id}><code>{e.event_type}</code> {e.license_key || e.key || ""}</p>)}{!events.length ? <p className="notice">No events yet.</p> : null}</div>
        <div className="card"><h2>Recent Uploads</h2>{uploads.map((u) => <p className="notice" key={u.id}><code>{u.file_name}</code> {u.license_key || ""}</p>)}{!uploads.length ? <p className="notice">No uploads yet.</p> : null}</div>
      </section>
    </main>
  );
}
