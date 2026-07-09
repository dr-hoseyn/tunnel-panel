"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmButton } from "@/components/ConfirmButton";

interface UserRow {
  id: string;
  email: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  createdAt: string;
}

const ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;

export function UsersTable({ users, currentUserId }: { users: UserRow[]; currentUserId: string }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeRole(id: string, role: string) {
    setError(null);
    const res = await fetch(`/api/v1/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to update role");
      return;
    }
    router.refresh();
  }

  async function removeUser(id: string) {
    setError(null);
    const res = await fetch(`/api/v1/users/${id}`, { method: "DELETE" });
    if (res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to remove user");
      return;
    }
    router.refresh();
  }

  async function createUser(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/v1/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
        role: form.get("role"),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create user");
      return;
    }
    setCreating(false);
    router.refresh();
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Users</h1>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
          >
            + Add user
          </button>
        )}
      </div>

      {creating && (
        <form onSubmit={createUser} className="mb-6 space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Email</label>
              <input
                name="email"
                type="email"
                required
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Password</label>
              <input
                name="password"
                type="password"
                required
                minLength={8}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-400">Role</label>
              <select
                name="role"
                defaultValue="VIEWER"
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" className="rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white">
              Create
            </button>
            <button type="button" onClick={() => setCreating(false)} className="text-xs text-neutral-500 hover:text-neutral-300">
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p className="mb-4 text-xs text-red-400">{error}</p>}

      <div className="overflow-hidden rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-normal">Email</th>
              <th className="px-4 py-2 font-normal">Role</th>
              <th className="px-4 py-2 font-normal">Created</th>
              <th className="px-4 py-2 font-normal">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-neutral-800">
                <td className="px-4 py-2 text-neutral-200">
                  {u.email}
                  {u.id === currentUserId && <span className="ml-2 text-xs text-neutral-500">(you)</span>}
                </td>
                <td className="px-4 py-2">
                  <select
                    value={u.role}
                    onChange={(e) => changeRole(u.id, e.target.value)}
                    disabled={u.id === currentUserId}
                    className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 disabled:opacity-50"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2 text-neutral-500">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-2">
                  {u.id !== currentUserId && (
                    <ConfirmButton onConfirm={() => removeUser(u.id)} label="Remove" confirmLabel="Delete" pendingLabel="Removing..." />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
