import { auth } from "@/auth";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";

export default async function SettingsPage() {
  const session = await auth();

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
    </div>
  );
}
