import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/SignOutButton";
import { StatusChip } from "@/components/StatusChip";
import { BRAND } from "@/lib/brand";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");

  return (
    <div className="flex-1 flex flex-col">
      <header className="border-b border-line bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
          <nav className="flex items-center gap-6">
            <Link href="/deals" className="ledger text-ink">
              {BRAND}
            </Link>
            <Link
              href="/deals"
              className="text-sm text-ink-muted hover:text-ink transition-colors"
            >
              Deals
            </Link>
            {profile.role === "client" && (
              <Link
                href="/deals/new"
                className="text-sm text-ink-muted hover:text-ink transition-colors"
              >
                New deal
              </Link>
            )}
          </nav>
          <div className="flex items-center gap-4">
            <StatusChip label={`${profile.role}: ${profile.display_name ?? profile.email}`} tone="info" />
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8">{children}</main>
    </div>
  );
}
