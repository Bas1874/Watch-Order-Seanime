/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// --- TYPE DEFINITIONS ---

// A chunk of text can be either plain or a clickable link.
type TextChunk = { type: 'text'; content: string } | { type: 'link'; content: string; href: string };
// An informational text block is composed of multiple chunks.
type InformationalText = { type: 'text'; content: TextChunk[] };
// An anime entry in the watch order.
type WatchOrderEntry = { type: 'anime'; data: $app.AL_Media };
// A display item can be a block of text or an anime card.
type DisplayItem = InformationalText | WatchOrderEntry;
// Structure for the link confirmation modal state.
type LinkConfirmation = { url: string; message: string };

// Define the structure of the API response
interface WatchOrderAPIResponse {
    data: {
        title: string;
        alternative_titles: string[];
        prologue: string | null;
        prologue_html: string | null;
        entry_notes: string | null;
        watch_orders: {
            name: string;
            description: string;
            description_html: string | null;
            steps: {
                step_title: string;
                is_optional: boolean;
                media: $app.AL_Media;
            }[];
        }[];
    }[];
}

function init() {

    $ui.register((ctx) => {

        const GITHUB_DATA_URL = "https://raw.githubusercontent.com/Bas1874/Anime-Watch-Order-Api/refs/heads/main/data/watch_order_api.json";
        
        // --- STATE MANAGEMENT ---
        
        const tray = ctx.newTray({ 
            tooltipText: "Watch Order",
            // --- THIS IS THE CHANGE ---
            iconUrl: "https://raw.githubusercontent.com/Bas1874/Watch-Order-Seanime/refs/heads/main/scr/icons/AnimeWatchOrderV3.png",
            withContent: true,
            width: '600px',
        });

        const displayItems = ctx.state<DisplayItem[]>([]);
        const isLoading = ctx.state<boolean>(false);
        const watchOrderDataCache = ctx.state<WatchOrderAPIResponse | null>(null);
        const currentMediaOnPage = ctx.state<$app.AL_Media | null>(null);
        // State for the link confirmation modal. Null when hidden.
        const linkConfirmation = ctx.state<LinkConfirmation | null>(null);

        // --- NAVIGATION & ACTIONS ---
        
        ctx.screen.onNavigate(async (e) => {
            if (e.pathname === "/entry" && !!e.searchParams.id) {
                const id = parseInt(e.searchParams.id);
                const media = await $anilist.getAnime(id);
                currentMediaOnPage.set(media);
            } else {
                currentMediaOnPage.set(null);
            }
        });
        ctx.screen.loadCurrent();

        const watchOrderButton = ctx.action.newAnimePageButton({ label: "Watch Order" });
        watchOrderButton.mount();
        
        // --- HELPER FUNCTIONS ---
        
        // Helper function to parse HTML content into structured text and link chunks.
        function parseHtmlToDisplayItems(html: string | null): InformationalText[] {
            if (typeof html !== 'string' || !html) {
                return [];
            }
            const $ = LoadDoc(html);
            const items: InformationalText[] = [];

            // Process each top-level block element (p, ul, ol, etc.)
            $('body > *').each((i, blockElement) => {
                const chunks: TextChunk[] = [];
                let currentText = "";

                // Process all child nodes (including text nodes and other elements) within the block
                blockElement.contents().each((_, node) => {
                    if (node.is('a')) {
                        if (currentText) {
                            chunks.push({ type: 'text', content: currentText });
                            currentText = "";
                        }
                        
                        let href = node.attr('href') || '#';
                        if (href.startsWith('/u/')) {
                            href = `https://www.reddit.com${href}`;
                        }

                        chunks.push({ type: 'link', content: node.text(), href: href });
                    } else {
                        currentText += node.text();
                    }
                });

                if (currentText) {
                    chunks.push({ type: 'text', content: currentText });
                }

                // Clean up chunks by merging adjacent text nodes
                if (chunks.length > 0) {
                    const mergedChunks: TextChunk[] = [];
                    chunks.forEach(chunk => {
                        const last = mergedChunks[mergedChunks.length - 1];
                        if (chunk.type === 'text' && last && last.type === 'text') {
                            last.content += chunk.content;
                        } else if (chunk.type === 'text' && chunk.content.trim() === '') {
                            // skip empty text chunks
                        } else {
                            mergedChunks.push(chunk);
                        }
                    });

                    if (mergedChunks.length > 0) {
                        items.push({ type: 'text', content: mergedChunks });
                    }
                }
            });
            return items;
        }

        async function fetchAndDisplayWatchOrder(media: $app.AL_Media) {
            const currentId = media.id;

            isLoading.set(true);
            displayItems.set([]);
            tray.open();

            try {
                let apiResponse = watchOrderDataCache.get();
                if (!apiResponse) {
                    const res = await ctx.fetch(GITHUB_DATA_URL);
                    apiResponse = res.ok ? res.json<WatchOrderAPIResponse>() : null;
                    if (apiResponse) watchOrderDataCache.set(apiResponse);
                }

                if (!apiResponse) {
                    ctx.toast.alert("Failed to fetch watch order data source.");
                    throw new Error("API data source is null.");
                }

                const seriesData = apiResponse.data.find(series =>
                    series.watch_orders.some(wo =>
                        wo.steps.some(step => step.media?.id === currentId)
                    )
                );
                
                let finalItems: DisplayItem[] = [];

                if (seriesData) {
                    const watchOrder = seriesData.watch_orders.find(wo =>
                        wo.steps.some(step => step.media?.id === currentId)
                    );

                    if (watchOrder) {
                        // Parse all informational text and add to the final list
                        const prologueItems = parseHtmlToDisplayItems(seriesData.prologue_html);
                        const notesItems = seriesData.entry_notes ? parseHtmlToDisplayItems(`<p>${seriesData.entry_notes}</p>`) : [];
                        const descriptionItems = parseHtmlToDisplayItems(watchOrder.description_html);
                        
                        finalItems.push(...prologueItems, ...notesItems, ...descriptionItems);

                        // Add anime steps to the final list
                        watchOrder.steps.forEach(step => {
                            if (step.media) {
                                finalItems.push({ type: 'anime', data: step.media });
                            }
                        });
                        
                        ctx.toast.success("Watch order loaded!");
                    } else {
                        finalItems.push({ type: 'text', content: [{ type: 'text', content: 'A watch order for this anime could not be found.' }] });
                    }
                } else {
                    finalItems.push({ type: 'text', content: [{ type: 'text', content: 'A watch order for this anime could not be found.' }] });
                }

                displayItems.set(finalItems);

            } catch (error: any) {
                console.error("[WatchOrder] An error occurred:", error);
                ctx.toast.alert("An error occurred while building the watch order.");
                displayItems.set([{ type: 'text', content: [{ type: 'text', content: 'An error occurred. Check the console for details.' }] }]);
            } finally {
                isLoading.set(false);
            }
        }

        // --- EVENT HANDLERS ---
        
        watchOrderButton.onClick(async (event) => {
            fetchAndDisplayWatchOrder(event.media);
        });
        
        tray.onClick(async () => {
            const media = currentMediaOnPage.get();
            if (media) {
                fetchAndDisplayWatchOrder(media);
            } else {
                isLoading.set(false);
                displayItems.set([{ type: 'text', content: [{type: 'text', content: "Navigate to an anime page to check its watch order."}] }]);
                tray.open();
            }
        });
        
        // --- TRAY RENDERING LOGIC ---

        tray.render(() => {
            const mainContent = () => {
                if (isLoading.get()) {
                    return tray.stack({ items: [tray.text("Loading watch order...")] });
                }

                const items = displayItems.get();
                if (items.length === 0) {
                    return tray.stack({ items: [tray.text("Click 'Watch Order' on an anime page or the tray icon.")] });
                }

                const listItems: any[] = [];
                items.forEach((item, index) => {
                    // --- RENDER INFORMATIONAL TEXT BLOCKS ---
                    if (item.type === 'text') {
                        const chunks = item.content;
                        const lineElements: any[] = [];
                        chunks.forEach(chunk => {
                            if (chunk.type === 'text') {
                                // FIX START: Apply 'break-word' directly to the text component
                                lineElements.push(tray.text(chunk.content, { 
                                    style: { 
                                        display: 'inline',
                                        wordBreak: 'break-word' 
                                    } 
                                }));
                                // FIX END
                            } else if (chunk.type === 'link') {
                                const eventHandlerId = `watch-order-link-${chunk.href}-${index}`;
                                lineElements.push(tray.button({
                                    label: chunk.content,
                                    intent: 'link',
                                    onClick: ctx.eventHandler(eventHandlerId, () => {
                                        linkConfirmation.set({ url: chunk.href, message: 'Open this external link?' });
                                    }),
                                    style: { display: 'inline-block', padding: '0', height: 'auto' }
                                }));
                            }
                        });
                        // FIX START: Change container style to 'normal' to let children control wrapping
                        listItems.push(tray.div(lineElements, {
                            style: {
                                whiteSpace: 'normal'
                            }
                        }));
                        // FIX END
                        return;
                    }
                    
                    // --- RENDER ANIME CARDS ---
                    if (item.type === 'anime') {
                        const animeData = item.data;
                        const formatMetadata = () => {
                            const parts = [];
                            if (animeData.format) parts.push(animeData.format.replace(/_/g, ' '));
                            if (animeData.mediaListEntry?.status) parts.push(animeData.mediaListEntry.status.charAt(0).toUpperCase() + animeData.mediaListEntry.status.slice(1).toLowerCase());
                            if (animeData.season) parts.push(animeData.season.charAt(0).toUpperCase() + animeData.season.slice(1).toLowerCase());
                            if (animeData.seasonYear) parts.push(animeData.seasonYear);
                            return parts.join(' · ');
                        };
                        
                        const eventHandlerId = `watch-order-nav-${animeData.id}`;

                        listItems.push(tray.div([
                            tray.flex({
                                items: [
                                    tray.div([], { style: { width: '40px', height: '56px', minWidth: '40px', backgroundImage: `url(${animeData.coverImage.large})`, backgroundSize: 'cover', backgroundPosition: 'center', borderRadius: '4px' } }),
                                    tray.stack({
                                        items: [
                                            tray.text(animeData.title.userPreferred, { isBold: true }),
                                            tray.text(formatMetadata(), { size: 'sm', color: 'gray' })
                                        ]
                                    })
                                ],
                                gap: 3,
                                style: { alignItems: 'center', padding: '4px' }
                            }),
                            
                            tray.button({
                                label: '', 
                                intent: 'unstyled',
                                style: { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', zIndex: '10', color: 'transparent' },
                                onClick: ctx.eventHandler(eventHandlerId, () => {
                                    ctx.screen.navigateTo("/entry", { id: String(animeData.id) });
                                    tray.close();
                                })
                            })
                        ], { style: { position: 'relative', borderRadius: '6px', cursor: 'pointer' } }));
                        
                        if (index < items.length - 1 && items[index + 1].type === 'anime') {
                            listItems.push(tray.text("↓", { style: { textAlign: 'center' } }));
                        }
                    }
                });
                return tray.stack({ items: listItems, gap: 2, style: { padding: '8px' } });
            };

            const linkConfirm = linkConfirmation.get();
            
            // --- RENDER THE ENTIRE TRAY (MAIN CONTENT + MODAL) ---
            return tray.div([
                mainContent(),
                ...(linkConfirm ? [
                    // --- LINK CONFIRMATION MODAL ---
                    tray.div([
                        // Backdrop to close modal on click
                        tray.button({
                            label: " ",
                            onClick: ctx.eventHandler('close-modal-backdrop', () => linkConfirmation.set(null)),
                            style: { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'transparent', border: 'none', zIndex: 0, cursor: 'default' }
                        }),
                        // Modal content
                        tray.div([
                            tray.stack([
                                tray.text(linkConfirm.message, { isBold: true, size: 'lg'}),
                                tray.text(linkConfirm.url, { size: "sm", color: "gray", style: { wordBreak: 'break-all' } }),
                                tray.flex([
                                    tray.div([
                                        tray.anchor({
                                            text: "Open",
                                            href: linkConfirm.url,
                                            target: "_blank",
                                            className: "bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm rounded-md px-4 py-2 transition-colors no-underline inline-flex items-center justify-center",
                                        })
                                    ], { onClick: ctx.eventHandler('confirm-open-link', () => ctx.setTimeout(() => linkConfirmation.set(null), 150)) }),
                                    tray.button({
                                        label: "Cancel",
                                        intent: "gray",
                                        onClick: ctx.eventHandler('cancel-open-link', () => linkConfirmation.set(null)),
                                    })
                                ], { style: { gap: '8px', justifyContent: 'center', marginTop: '12px' }})
                            ], { style: { gap: '8px', alignItems: 'center' }})
                        ], {
                            style: { background: '#111827', border: '1px solid #374151', padding: '20px', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)', minWidth: '300px', maxWidth: '90%', position: 'relative', zIndex: 1 },
                        })
                    ], { style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0, 0, 0, 0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 } })
                ] : []),
            ], { style: { position: 'relative', height: '100%' } });
        });
    });
}
