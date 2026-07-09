import { NextResponse } from "next/server";
import { listCoreDescriptors } from "@/lib/cores/registry";
import { requireRoleResponse } from "@/lib/rbac";

/** Serializable projection of the core registry for client components (the
 * create-tunnel wizard) -- omits the zod schema, which isn't JSON-safe and
 * is only ever used server-side for validation. */
export async function GET() {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const cores = listCoreDescriptors().map((d) => ({
    core: d.core,
    label: d.label,
    description: d.description,
    portsOn: d.portsOn,
    defaultPort: d.defaultPort,
    firewallProto: d.firewallProto,
    extraFields: d.extraFields,
  }));
  return NextResponse.json({ cores });
}
