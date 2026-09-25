import { Logo } from "./assets/logo";

export const baseConfig = {
  name: "Discord",
  id: "discord",
  category: "capture" as const,
  active: true,
  beta: true,
  logo: Logo,
  short_description:
    "Chat with the Midday assistant, upload receipts, and receive financial notifications directly in Discord.",
  description:
    "Connect your Discord account to Midday and manage your finances from your configured server channel.\n\n**Midday Assistant**\nAsk questions about spending, transactions, invoices, and business performance through a natural Discord conversation.\n\n**Upload Receipts & Invoices**\nSend supported files and images in Discord to add them to your Midday inbox for extraction and matching.\n\n**Financial Notifications**\nReceive updates for transactions, invoices, receipt processing, and document matches.\n\n**Secure Account Linking**\nMidday generates a short-lived connection code that links your Discord user to the current workspace.",
  settings: [
    {
      id: "transactions",
      label: "Transactions",
      description: "Get notified about new transactions and spending activity.",
      type: "switch" as const,
      required: false,
      value: true,
    },
    {
      id: "invoices",
      label: "Invoices",
      description:
        "Get notified when invoices are paid, overdue, or need attention.",
      type: "switch" as const,
      required: false,
      value: true,
    },
    {
      id: "receipts",
      label: "Receipt Processing",
      description:
        "Automatically extract and match receipts sent through Discord.",
      type: "switch" as const,
      required: false,
      value: true,
    },
    {
      id: "matches",
      label: "Match Notifications",
      description:
        "Get notified when uploads are matched to transactions or need review.",
      type: "switch" as const,
      required: false,
      value: true,
    },
  ],
};
