import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("jira");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
