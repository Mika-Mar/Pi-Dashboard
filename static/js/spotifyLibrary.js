import { jget, jpost } from "./api.js";

export function initSpotifyLibrary({
  nowPlayingEl,
  libraryEl,
  openButton,
  backButton,
  itemsEl,
  statusEl,
  onPlaybackStarted,
}) {
  let hasTrack = false;
  let manuallyOpened = false;
  let startingPlayback = false;
  let waitingForPlayback = false;
  let loading = null;
  let lastLoadedAt = 0;
  let destroyed = false;
  const cacheMs = 60000;

  function setStatus(message = "", login = false) {
    if (!statusEl) return;
    statusEl.replaceChildren();
    if (message) statusEl.append(document.createTextNode(message));
    if (login) {
      const link = document.createElement("a");
      link.href = "/spotify/login";
      link.textContent = " Spotify verbinden";
      statusEl.append(link);
    }
  }

  function updateViews(showLibrary) {
    if (nowPlayingEl) nowPlayingEl.hidden = showLibrary;
    if (libraryEl) libraryEl.hidden = !showLibrary;
    if (openButton) openButton.hidden = !hasTrack || showLibrary;
    if (backButton) backButton.hidden = !hasTrack;
  }

  async function showLibrary({ manual = true } = {}) {
    manuallyOpened = manual && hasTrack;
    updateViews(true);
    await refreshLibrary();
  }

  function showNowPlaying() {
    if (!hasTrack) return;
    manuallyOpened = false;
    updateViews(false);
  }

  function createItem({ type, id = "", name, subtitle, coverUrl, disabled = false }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "spotifyLibraryItem";
    button.dataset.type = type;
    if (id) button.dataset.id = id;
    button.disabled = disabled;
    button.setAttribute("aria-label", `${name} zufällig abspielen`);

    const art = document.createElement("span");
    art.className = "spotifyLibraryArt";
    if (coverUrl) {
      const image = document.createElement("img");
      image.src = coverUrl;
      image.alt = "";
      image.loading = "lazy";
      art.append(image);
    } else {
      art.classList.add("spotifyLibraryArt--liked");
      art.textContent = "♥";
    }

    const text = document.createElement("span");
    text.className = "spotifyLibraryText";
    const title = document.createElement("span");
    title.className = "spotifyLibraryTitle";
    title.textContent = name;
    const detail = document.createElement("span");
    detail.className = "spotifyLibrarySubtitle";
    detail.textContent = subtitle;
    text.append(title, detail);
    button.append(art, text);
    return button;
  }

  function renderLibrary(data) {
    if (!itemsEl) return;
    const favorites = data.favorites || {};
    const count = Number(favorites.track_count || 0);
    const items = [createItem({
      type: "liked",
      name: favorites.name || "Lieblingssongs",
      subtitle: count ? `${count} Songs` : "Keine gespeicherten Songs",
      disabled: count === 0,
    })];
    (data.albums || []).slice(0, 5).forEach((album) => {
      items.push(createItem({
        type: "album",
        id: album.id,
        name: album.name || "Unbekanntes Album",
        subtitle: (album.artists || []).join(", ") || "Album",
        coverUrl: album.cover_url,
        disabled: !album.id,
      }));
    });
    itemsEl.replaceChildren(...items);
  }

  async function refreshLibrary(force = false) {
    if (destroyed || !itemsEl || (!force && Date.now() - lastLoadedAt < cacheMs)) return;
    if (loading) return loading;
    itemsEl.setAttribute("aria-busy", "true");
    setStatus("Musik wird geladen …");
    loading = (async () => {
      try {
        const data = await jget("/api/spotify/library", { cache: "no-store" });
        if (destroyed) return;
        renderLibrary(data);
        lastLoadedAt = Date.now();
        setStatus((data.albums || []).length ? "" : "Noch keine zuletzt gehörten Alben.");
      } catch (error) {
        if (destroyed) return;
        itemsEl.replaceChildren();
        setStatus(error.data?.error === "not_authed"
          ? "Für Favoriten und Verlauf erneut autorisieren."
          : "Deine Spotify-Auswahl konnte nicht geladen werden.",
        error.data?.error === "not_authed");
      } finally {
        loading = null;
        itemsEl.removeAttribute("aria-busy");
      }
    })();
    return loading;
  }

  async function startSelection(button) {
    if (startingPlayback || button.disabled) return;
    startingPlayback = true;
    itemsEl?.querySelectorAll("button").forEach((item) => { item.disabled = true; });
    setStatus("Zufällige Wiedergabe wird gestartet …");
    try {
      const result = await jpost("/api/spotify/library/play", {
        type: button.dataset.type,
        id: button.dataset.id || undefined,
      });
      waitingForPlayback = true;
      setStatus("Wiedergabe wird auf dem aktiven Gerät gestartet …");
      await onPlaybackStarted?.(result);
    } catch (error) {
      const messages = {
        no_active_device: "Wähle oder aktiviere zuerst ein Spotify-Gerät.",
        empty_selection: "Diese Auswahl enthält keine abspielbaren Songs.",
        not_authed: "Spotify muss erneut autorisiert werden.",
      };
      setStatus(messages[error.data?.error] || "Wiedergabe konnte nicht gestartet werden.",
        error.data?.error === "not_authed");
    } finally {
      startingPlayback = false;
      itemsEl?.querySelectorAll("button").forEach((item) => {
        item.disabled = item.dataset.type === "liked"
          && item.querySelector(".spotifyLibrarySubtitle")?.textContent.startsWith("Keine");
      });
    }
  }

  function onItemsClick(event) {
    const button = event.target.closest(".spotifyLibraryItem");
    if (button && itemsEl?.contains(button)) void startSelection(button);
  }

  function setHasTrack(value) {
    const hadTrack = hasTrack;
    hasTrack = !!value;
    if (!hasTrack) {
      void showLibrary({ manual: false });
    } else if (startingPlayback || waitingForPlayback || (!hadTrack && !manuallyOpened)) {
      waitingForPlayback = false;
      showNowPlaying();
    } else {
      updateViews(manuallyOpened);
    }
  }

  const open = () => { void showLibrary(); };
  openButton?.addEventListener("click", open);
  backButton?.addEventListener("click", showNowPlaying);
  itemsEl?.addEventListener("click", onItemsClick);
  updateViews(false);

  return {
    setHasTrack,
    refresh: () => refreshLibrary(true),
    show: open,
    destroy() {
      destroyed = true;
      openButton?.removeEventListener("click", open);
      backButton?.removeEventListener("click", showNowPlaying);
      itemsEl?.removeEventListener("click", onItemsClick);
    },
  };
}
