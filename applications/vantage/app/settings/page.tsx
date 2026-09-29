import type { Metadata } from "next";
import AppChrome from "@/components/AppChrome";
import SettingsForm from "@/components/SettingsForm";

export const metadata: Metadata = {
  title: "Settings",
  description: "Choose a model provider and supply your own API key.",
};

export default function SettingsPage() {
  return (
    <AppChrome>
      <SettingsForm />
    </AppChrome>
  );
}
