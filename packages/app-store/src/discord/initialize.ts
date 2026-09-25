export const onInitialize = async ({
  onComplete,
}: {
  accessToken: string;
  onComplete?: () => void;
}) => {
  window.dispatchEvent(new CustomEvent("openDiscordConnect"));

  if (onComplete) {
    onComplete();
  }
};
