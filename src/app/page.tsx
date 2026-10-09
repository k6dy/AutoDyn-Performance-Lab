import AppShell from "@/components/AppShell";
import { AppProvider } from "@/state/AppProvider";

export default function Home() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
