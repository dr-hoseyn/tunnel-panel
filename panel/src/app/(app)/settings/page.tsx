import { auth } from "@/auth";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { SystemSettingsForm } from "@/components/SystemSettingsForm";
import { getSettings } from "@/lib/settings";

export default async function SettingsPage() {
  const session = await auth();
  const role = session?.user?.role ?? "VIEWER";

  return (
    <div>
      <h1 className="mb-6 text-lg font-semibold">Settings</h1>

      <section className="mb-8">
        <h2 className="mb-1 text-sm font-medium text-neutral-300">Account</h2>
        <p className="mb-4 text-xs text-neutral-500">
          Signed in as {session?.user?.email} ({session?.user?.role})
        </p>
        <ChangePasswordForm />
      </section>

      <section>
        <h2 className="mb-1 text-sm font-medium text-neutral-300">System</h2>
        <p className="mb-4 text-xs text-neutral-500">
          Operational knobs for the background health sampler and deployment queue. Changes apply within a few
          seconds, no restart required.
        </p>
        {role === "ADMIN" ? (
          <SystemSettingsForm initial={await getSettings()} />
        ) : (
          <p className="text-xs text-neutral-500">Only Admins can view and change system settings.</p>
        )}
      </section>
    </div>
  );
}
