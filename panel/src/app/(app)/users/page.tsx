import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { UsersTable } from "@/components/UsersTable";

export default async function UsersPage() {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    redirect("/dashboard");
  }

  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return (
    <UsersTable
      users={users.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }))}
      currentUserId={session.user.id}
    />
  );
}
