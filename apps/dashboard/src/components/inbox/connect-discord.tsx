"use client";

import { Button } from "@midday/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@midday/ui/dialog";
import { Icons } from "@midday/ui/icons";
import { Spinner } from "@midday/ui/spinner";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTRPC } from "@/trpc/client";
import { useConnectDialogReset } from "./use-connect-dialog";

interface ConnectDiscordProps {
  showTrigger?: boolean;
}

export function ConnectDiscord({ showTrigger = true }: ConnectDiscordProps) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [linkCode, setLinkCode] = useState("");
  const { data: installedApps } = useQuery(trpc.apps.get.queryOptions());
  const { data: discordSetup } = useQuery(
    trpc.apps.discordSetup.queryOptions(),
  );
  const discordApp = installedApps?.find((app) => app.app_id === "discord");
  const connections = ((discordApp?.config as { connections?: unknown[] })
    ?.connections ?? []) as Array<{
    userId: string;
    username?: string;
    displayName?: string;
  }>;
  const channelUrl = process.env.NEXT_PUBLIC_DISCORD_CHANNEL_URL || "";
  const installUrl = discordSetup?.installUrl ?? "";
  const discordConfigured = Boolean(installUrl || channelUrl);
  const linkMessage = linkCode ? `Connect to Midday: ${linkCode}` : "";

  const createLinkTokenMutation = useMutation(
    trpc.apps.createPlatformLinkToken.mutationOptions({
      onSuccess: (token) => setLinkCode(token.code),
    }),
  );

  const handleOpenChange = useConnectDialogReset({
    setOpen,
    setLinkCode,
    setQrCodeUrl: () => {},
    setCopied,
    resetMutation: () => createLinkTokenMutation.reset(),
  });

  useEffect(() => {
    if (!open || !discordConfigured || linkCode) return;

    createLinkTokenMutation
      .mutateAsync({ provider: "discord" })
      .catch(() => setLinkCode(""));
  }, [open, discordConfigured, linkCode]);

  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener("openDiscordConnect", handleOpen);
    return () => window.removeEventListener("openDiscordConnect", handleOpen);
  }, []);

  const copyToClipboard = async () => {
    if (!linkMessage) return;

    try {
      await navigator.clipboard.writeText(linkMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {showTrigger && (
        <DialogTrigger asChild>
          <Button
            className="px-6 py-4 w-full font-medium h-[40px]"
            variant="outline"
          >
            <div className="flex items-center space-x-2">
              <Icons.Discord className="size-5" />
              <span>
                {connections.length > 0
                  ? `Discord (${connections.length} connected)`
                  : "Connect Discord"}
              </span>
            </div>
          </Button>
        </DialogTrigger>
      )}

      <DialogContent className="sm:max-w-[440px] p-0" hideClose>
        <div className="p-6 pb-0">
          <DialogHeader>
            <DialogTitle>Set up Discord</DialogTitle>
            <DialogDescription>
              Add Midday to your server, then link your Discord account to this
              workspace.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex flex-col space-y-5 p-6">
          <div className="flex gap-3">
            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <p className="text-sm font-medium">Add Midday to your server</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose the Discord server where you want to use the assistant.
                </p>
              </div>

              {installUrl ? (
                <Button asChild className="w-full" variant="outline">
                  <a
                    href={installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Icons.Discord className="mr-2 size-4" />
                    Add to Discord
                    <Icons.ExternalLink className="ml-2 size-3.5" />
                  </a>
                </Button>
              ) : (
                <Button className="w-full" variant="outline" disabled>
                  Discord installation unavailable
                </Button>
              )}
            </div>
          </div>

          <div className="flex gap-3 border-t pt-5">
            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <p className="text-sm font-medium">Link this workspace</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  In a channel where Midday can read and send messages, paste
                  this one-time message.
                </p>
              </div>

              <div className="w-full rounded-md border p-4 text-center text-sm">
                {!discordConfigured ? (
                  <span className="text-destructive">
                    Discord is not configured for this deployment.
                  </span>
                ) : createLinkTokenMutation.isError ? (
                  <span className="text-destructive">
                    Failed to generate link code.
                  </span>
                ) : linkMessage ? (
                  linkMessage
                ) : (
                  <span className="inline-flex items-center gap-2 text-muted-foreground">
                    <Spinner className="size-4 animate-spin" />
                    Generating link code...
                  </span>
                )}
              </div>

              <div className="flex gap-2">
                {channelUrl && (
                  <Button asChild className="flex-1" variant="outline">
                    <a
                      href={channelUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open Discord
                    </a>
                  </Button>
                )}
                <Button
                  onClick={
                    createLinkTokenMutation.isError
                      ? () =>
                          createLinkTokenMutation.mutate({
                            provider: "discord",
                          })
                      : copyToClipboard
                  }
                  variant="outline"
                  className="flex-1"
                  disabled={
                    !discordConfigured ||
                    createLinkTokenMutation.isPending ||
                    (!linkMessage && !createLinkTokenMutation.isError)
                  }
                >
                  {createLinkTokenMutation.isError ? (
                    "Retry"
                  ) : copied ? (
                    <>
                      <Icons.Check className="mr-2 size-4" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Icons.Copy className="mr-2 size-4" />
                      Copy message
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>

          {connections.length > 0 && (
            <div className="w-full border-t pt-4">
              <p className="text-sm font-medium mb-2">Connected accounts:</p>
              <div className="space-y-2">
                {connections.map((connection) => (
                  <div
                    key={connection.userId}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-[#878787]">
                      {connection.displayName || connection.username || "User"}
                    </span>
                    <span className="text-xs text-[#878787]">
                      {connection.username ? `@${connection.username}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
