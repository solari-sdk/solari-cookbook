// Adapted from pingdotgg/t3code apps/web/src/components/ChatMarkdown.tsx at 57a66608 (MIT).
// Differs from upstream: useTheme is the resolvedTheme prop, getClientSettings().wordWrap is the wordWrap prop, the right-panel store is the onOpenFile prop; citations, the selection toolbar, asset images, the video player, toasts and PR link resolution are removed.
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FileIcon,
  GlobeIcon,
  InfoIcon,
  LightbulbIcon,
  Maximize2Icon,
  MessageSquareWarningIcon,
  Minimize2Icon,
  OctagonAlertIcon,
  TriangleAlertIcon,
  WrapTextIcon,
} from "lucide-react";
import React, {
  Children,
  Suspense,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  isValidElement,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components, Options as ReactMarkdownOptions } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkGithubAlerts } from "../lib/markdownGithubAlerts";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import type { ProviderSkill } from "./chat/adapt";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
} from "./composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { ScrollArea } from "./ui/scroll-area";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import {
  chatMarkdownClipboardPayload,
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../lib/markdownClipboard";
import { remarkNormalizeListItemIndentation } from "../lib/markdownListIndentation";
import {
  extractMarkdownLinkHrefs,
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../lib/markdownLinks";
import { inlineCodeFilePathCandidate } from "../lib/markdownLinkParsing";
import { classifyMarkdownImageSource } from "../lib/markdownImages";
import { mediaKindFromPath } from "../lib/filePreview";
import { isAbsolutePath } from "../terminal-links";
import { cn } from "../lib/utils";
import { Spaced } from "./ui/spaced";

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<ProviderSkill>;
  className?: string;
  /** Treat single newlines as hard breaks (chat-style user input). */
  lineBreaks?: boolean;
  /** Parse sanitized raw HTML instead of displaying its source text. */
  parseRawHtml?: boolean;
  /** Directory that anchors relative links and images; defaults to `cwd`. Set
      to the file's own directory when rendering a markdown file. */
  imageBaseDir?: string | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  /** Picks the shiki theme for fenced code. */
  resolvedTheme: "light" | "dark";
  /** Initial value of the per-block wrap toggle; default true. */
  wordWrap?: boolean;
  /** A file link was clicked. Absent means file links render as plain text chips. */
  onOpenFile?: ((path: string, line?: number) => void) | undefined;
  /** A file nobody here wrote, a skill's SKILL.md: no raw HTML, no image fetched, no link but to a web page, a mail
   * address or a heading, and nothing resolved against a folder. */
  restricted?: boolean;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<ProviderSkill> = [];
const EMPTY_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [];

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: "markdown" | "csv";
  readonly language?: string;
  readonly fenceTitle?: string;
  readonly copyTarget?: string;
}

function reportMarkdownActionFailure(context: MarkdownActionFailureContext, cause: unknown): void {
  console.error("[chat-markdown] action failed", context, cause);
}

const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

/**
 * The default `1.25rem` marker gutter (`.chat-markdown ol`) fits one-character
 * markers. Wider markers can extend past it and get clipped by a collapsed
 * message's overflow. Widen the gutter to fit the widest marker, including a
 * negative marker's minus sign.
 */
export function orderedListGutterStyle(
  itemCount: number,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 1}ch` };
}

type MarkdownImageHastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageHastNode[];
};

/** Carries authored image source metadata through the sanitizer to the image renderer. */
function rehypePreserveImageSourceMeta() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (node: MarkdownImageHastNode) => {
      const src = node.properties?.src;
      const title = node.properties?.title;
      if (node.type === "element" && node.tagName === "img") {
        node.properties = {
          ...node.properties,
          ...(typeof src === "string" && isWindowsDrivePathHref(src) ? { dataLocalSrc: src } : {}),
          ...(typeof title === "string" ? { dataMarkdownTitle: title } : {}),
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta", "dataInlineCode"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    img: [...(defaultSchema.attributes?.img ?? []), "dataLocalSrc", "dataMarkdownTitle"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
    src: [...(defaultSchema.protocols?.src ?? []), "file"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

const CHAT_MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS = [
  remarkGfm,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const CHAT_MARKDOWN_REHYPE_PLUGINS = [
  rehypeRaw,
  rehypePreserveImageSourceMeta,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

/** The sanitizer's schema for a restricted file: no image, links only to web pages and mail addresses, no source
 * for anything, and the span the restricted plugin writes for an image or a link it took apart. */
const SKILL_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== "img"),
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    span: [...(defaultSchema.attributes?.span ?? []), "dataK", "className"],
  },
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto"], src: [] },
} satisfies Parameters<typeof rehypeSanitize>[0];

const RESTRICTED_FACT_CLASS = ["font-mono", "text-[11px]", "text-muted-foreground"];

/** Whether a restricted file's link may stay one: a web page, a mail address, or a place in the same document. */
const restrictedHref = (href: unknown): href is string => typeof href === "string" && (/^(https?:|mailto:)/i.test(href) || href.startsWith("#"));

type RestrictedNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: RestrictedNode[] };

/** Takes apart what a restricted file may not do before the sanitizer sees it: raw HTML becomes its own source text,
 * an image becomes its alt text and its address, and a link to anything but a web page, a mail address or a heading
 * becomes its text and its address with no anchor. */
function rehypeRestrict() {
  const text = (value: string): RestrictedNode => ({ type: "text", value });
  const fact = (value: string, k: string): RestrictedNode => ({ type: "element", tagName: "span", properties: { dataK: k, className: RESTRICTED_FACT_CLASS }, children: [text(value)] });
  const visit = (node: RestrictedNode): RestrictedNode => {
    if (node.type === "raw") return text(node.value ?? "");
    if (node.type === "element" && node.tagName === "img") {
      const alt = typeof node.properties?.alt === "string" ? node.properties.alt : "";
      const src = typeof node.properties?.src === "string" ? node.properties.src : "";
      return fact([alt, src].filter((w) => w !== "").join(" "), "skill-image");
    }
    const children = node.children?.map(visit);
    if (node.type === "element" && node.tagName === "a" && !restrictedHref(node.properties?.href)) {
      const href = typeof node.properties?.href === "string" ? node.properties.href : "";
      return { type: "element", tagName: "span", properties: { dataK: "skill-link" }, children: [...(children ?? []), ...(href === "" ? [] : [text(" "), fact(href, "skill-link-href")])] };
    }
    return children === undefined ? node : { ...node, children };
  };
  return (tree: RestrictedNode) => visit(tree);
}

const SKILL_MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkGithubAlerts, remarkNormalizeListItemIndentation, remarkPreserveCodeMeta] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const SKILL_MARKDOWN_REHYPE_PLUGINS = [rehypeRestrict, [rehypeSanitize, SKILL_SANITIZE_SCHEMA]] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

/** GitHub's own five alert kinds, in its colors: the glyph names the urgency, the title says it. */
const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-red-600 dark:text-red-400",
  },
};

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

/** Pulls a filename out of fence meta: ```ts title="x.ts" / ```ts src/main.ts */
function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3];
  if (attrTitle) return attrTitle;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null;
}

function extractPreCodeMeta(node: unknown): string | undefined {
  const children = (
    node as
      | {
          children?: Array<{
            type?: string;
            tagName?: string;
            data?: { meta?: unknown };
            properties?: { dataCodeMeta?: unknown };
          }>;
        }
      | undefined
  )?.children;
  const codeNode = children?.find((child) => child?.type === "element" && child.tagName === "code");
  const meta = codeNode?.properties?.dataCodeMeta ?? codeNode?.data?.meta;
  return typeof meta === "string" && meta.trim().length > 0 ? meta.trim() : undefined;
}

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  url?: string;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

/**
 * Preserve Windows drive links as allowed `file:` URLs before sanitization.
 * The same traversal tags inline code while it can still be distinguished
 * from fenced code. Code inside links stays untagged to avoid nested anchors.
 */
function remarkNormalizeLinksAndTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (
        (node.type === "link" || node.type === "definition") &&
        typeof node.url === "string" &&
        WINDOWS_DRIVE_PATH_REGEX.test(node.url)
      ) {
        node.url = `file:///${node.url.replaceAll("\\", "/")}`;
      }
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode; node?: { tagName?: string } }>(
      onlyChild,
    )
  ) {
    return null;
  }
  // With a custom `code` component the child's type is that component, not
  // the "code" tag; the hast node react-markdown attaches still names it.
  if (onlyChild.type !== "code" && onlyChild.props.node?.tagName !== "code") {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function MarkdownTable({
  wordWrap,
  children,
  ...props
}: React.ComponentProps<"table"> & { wordWrap: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [expanded, setExpanded] = useState(wordWrap);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  const copyLabel = copied ? "Copied" : "Copy table";

  function toggleExpanded() {
    const table = tableRef.current;
    if (!table) return;

    if (!expanded) {
      const rows = [...table.rows];
      const columnWidths = rows.reduce<number[]>((widths, row) => {
        [...row.cells].forEach((cell, columnIndex) => {
          widths[columnIndex] = Math.max(
            widths[columnIndex] ?? 0,
            cell.getBoundingClientRect().width,
          );
        });
        return widths;
      }, []);

      [...(table.tHead?.rows[0]?.cells ?? [])].forEach((cell, columnIndex) => {
        cell.style.minWidth = `${columnWidths[columnIndex] ?? cell.getBoundingClientRect().width}px`;
      });
    }

    setExpanded((value) => !value);
  }

  const handleCopy = useCallback((format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table || typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    const text =
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure({ operation: "copy-table", format }, cause);
      });
  }, []);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="chat-markdown-table-container"
      data-expanded={expanded ? "true" : "false"}
    >
      <ScrollArea chainVerticalScroll scrollFade className="w-full max-w-full rounded-none">
        <table ref={tableRef} {...props}>
          {children}
        </table>
      </ScrollArea>
      <div className="mt-0.5 flex items-center justify-between select-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="chat-markdown-chrome-action"
                aria-pressed={expanded}
                onClick={toggleExpanded}
                aria-label={expandLabel}
              />
            }
          >
            {expanded ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
          </TooltipTrigger>
          <TooltipPopup side="top">{expandLabel}</TooltipPopup>
        </Tooltip>
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="chat-markdown-chrome-action"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

function MarkdownDetails({
  children,
  open = false,
}: Pick<React.ComponentProps<"details">, "children" | "open">) {
  const [isOpen, setIsOpen] = useState(open);
  const childNodes = Children.toArray(children);
  const summaryIndex = childNodes.findIndex(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const summaryNode = summaryIndex >= 0 ? childNodes[summaryIndex] : null;
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : "Details";
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  return (
    <Collapsible
      defaultOpen={open}
      onOpenChange={setIsOpen}
      className="chat-markdown-details my-2 border-y border-border/60"
      data-markdown-details=""
      data-markdown-details-open={isOpen ? "true" : "false"}
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90"
        data-markdown-details-summary=""
      >
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground transition-transform"
          aria-hidden
        />
        <span>{summary}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pb-3 ps-6 text-foreground/80" data-markdown-details-content="">
          {content}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Filename titles render icon + text; language-only titles render the language text. */
function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
}: {
  fenceTitle: string | null;
  language: string;
}) {
  if (fenceTitle) {
    return (
      <>
        <FileIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  return <span className="truncate">{language}</span>;
}

function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  wordWrap,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  wordWrap: boolean;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(wordWrap);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure(
          {
            operation: "copy-code-block",
            language,
            ...(fenceTitle ? { fenceTitle } : {}),
          },
          cause,
        );
      });
  }, [code, fenceTitle, language]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-[var(--radius)] border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none">
        <span className="inline-flex min-w-0 items-center gap-[0.4rem] [font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace)] [font-size:0.6875rem]">
          <MarkdownCodeBlockTitleContent fenceTitle={fenceTitle} language={language} />
        </span>
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={wrapped}
                  onClick={() => setWrapped((value) => !value)}
                  aria-label={wrapLabel}
                />
              }
            >
              <WrapTextIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      {children}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      // shiki cuts a line at 500 ms with no signal, and a cold grammar compiling its regexes on a busy main thread takes longer than that.
      return highlighter.codeToHtml(code, { lang: language, theme: themeName, tokenizeTimeLimit: 0 });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

interface MarkdownFileLinkProps {
  targetPath: string;
  displayPath: string;
  /** What the files panel opens: workspace-relative inside the workspace, the
      absolute host path outside it, null when the panel cannot show the file. */
  panelPath: string | null;
  line?: number | undefined;
  label: ReadonlyArray<string>;
  copyMarkdown: string;
  onOpenFile?: ((path: string, line?: number) => void) | undefined;
  className?: string | undefined;
}

const CHAT_FILE_TAG_CHIP_CLASS_NAME = CHAT_INLINE_CHIP_CLASS_NAME;
const MARKDOWN_FILE_CHIP_CLASS_NAME = "chat-markdown-file-link";
const MARKDOWN_FILE_LINK_CLASS_NAME = `${MARKDOWN_FILE_CHIP_CLASS_NAME} cursor-pointer transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70`;

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

function buildFileLinkParentSuffixByPath(filePaths: ReadonlyArray<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const normalizedPath = filePath.replaceAll("\\", "/");
    const pathSegments = normalizedPath.split("/").filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(normalizedPath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?(?:```|$))/;
const INLINE_CODE_SPAN_PATTERN = /`([^`\n]+)`/g;

function extractInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  const segments = text.split(FENCED_CODE_SEGMENT_PATTERN);
  for (let index = 0; index < segments.length; index += 2) {
    for (const match of (segments[index] ?? "").matchAll(INLINE_CODE_SPAN_PATTERN)) {
      const span = match[1]?.trim();
      if (span) spans.push(span);
    }
  }
  return spans;
}

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

function resolveExternalWebLinkHost(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

/** Resolves protocol-relative web references against the page's own protocol. */
function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) return src;
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  return `${protocol}${src}`;
}

const MARKDOWN_LINK_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

/** Hosts whose favicon request already failed this session; skip straight to the globe. */
const failedFaviconHosts = new Set<string>();

const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
  const [failedHost, setFailedHost] = useState<string | null>(null);
  return (
    <span
      className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
      aria-hidden
    >
      {failedHost === host || failedFaviconHosts.has(host) ? (
        <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn(MARKDOWN_LINK_FAVICON_CLASS_NAME, "rounded-sm")}
          onError={() => {
            failedFaviconHosts.add(host);
            setFailedHost(host);
          }}
        />
      )}
    </span>
  );
});

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);

function markdownImageCopy(alt: string, src: string, title: string | undefined): string {
  const escapedAlt = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const titleSuffix =
    title === undefined ? "" : ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `![${escapedAlt}](${src}${titleSuffix})`;
}

function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
): CSSProperties | undefined {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(30 * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

const MarkdownLinkContext = React.createContext(false);

function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  src: string,
  alt: string,
  originalUrl?: string,
) {
  if (!onImageExpand) return {};
  const previewName = alt.trim() || "image";
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    onImageExpand({
      images: [
        {
          src,
          name: previewName,
          ...(originalUrl ? { originalUrl } : {}),
        },
      ],
      index: 0,
    });
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

function ChatMarkdownImageFallback(props: {
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly kind?: "image" | "video";
}) {
  const label = props.kind === "video" ? "Video unavailable" : "Image unavailable";
  return (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        {props.alt.length > 0 ? `${label}: ${props.alt}` : label}
      </span>
    </span>
  );
}

function leadingExternalLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  return Math.min(text.length, 1);
}

function breakableExternalLinkText(text: string): ReactNode[] {
  return Array.from(text, (character, index) => (
    <React.Fragment key={`${index}:${character}`}>
      {character}
      <wbr />
    </React.Fragment>
  ));
}

function plainHastText(node: unknown): string | null {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return null;
  }
  const parts = node.children.map((child) => {
    if (
      child &&
      typeof child === "object" &&
      "type" in child &&
      child.type === "text" &&
      "value" in child &&
      typeof child.value === "string"
    ) {
      return child.value;
    }
    return null;
  });
  return parts.every((part) => part !== null) ? parts.join("") : null;
}

/**
 * Whether the link carries any words of its own. An anchor that is only an image (a badge, a
 * "Fix in Cursor" button) already shows its identity, and a favicon bolted on in front of it
 * is a stray logo rather than a hint.
 */
function hastHasText(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (
    "type" in node &&
    node.type === "text" &&
    "value" in node &&
    typeof node.value === "string" &&
    node.value.trim().length > 0
  ) {
    return true;
  }
  return "children" in node && Array.isArray(node.children) && node.children.some(hastHasText);
}

const SANITIZED_FRAGMENT_PREFIX = "user-content-";

function decodeMarkdownFragmentId(href: string): string {
  const encodedId = href.slice(1);
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}

function normalizeSanitizedFragmentId(id: string): string {
  let normalizedId = id;
  while (normalizedId.startsWith(SANITIZED_FRAGMENT_PREFIX)) {
    normalizedId = normalizedId.slice(SANITIZED_FRAGMENT_PREFIX.length);
  }
  return normalizedId;
}

function findMarkdownFragmentTarget(anchor: HTMLAnchorElement, href: string): HTMLElement | null {
  const decodedId = decodeMarkdownFragmentId(href);
  const normalizedId = normalizeSanitizedFragmentId(decodedId);
  const matchesFragment = (element: HTMLElement) =>
    element.id === decodedId || normalizeSanitizedFragmentId(element.id) === normalizedId;
  const markdownRoot = anchor.closest<HTMLElement>(".chat-markdown");
  if (markdownRoot) {
    const localTargets = Array.from(markdownRoot.querySelectorAll<HTMLElement>("[id]"));
    const localTarget = localTargets.find(matchesFragment);
    if (localTarget) return localTarget;
  }

  return (
    document.getElementById(decodedId) ??
    Array.from(document.querySelectorAll<HTMLElement>("[id]")).find(matchesFragment) ??
    null
  );
}

function handleMarkdownFragmentClick(event: ReactMouseEvent<HTMLAnchorElement>, href: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  const target = findMarkdownFragmentTarget(event.currentTarget, href);
  if (!target) return;

  event.preventDefault();
  // The page's address is the app's one record of which thread is open, so a heading inside a reply scrolls to
  // itself and writes nothing: its fragment over that address would cost the person their place on the next load.
  target.scrollIntoView({ block: "nearest" });
}

function MarkdownExternalLinkContent({
  host,
  plainText,
  children,
}: {
  host: string;
  plainText: string | null;
  children: ReactNode;
}) {
  if (plainText) {
    const leadingLength = leadingExternalLinkTextLength(plainText);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon host={host} />
          {plainText.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(plainText.slice(leadingLength))}
      </>
    );
  }

  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0];

  if (typeof firstChild === "string" && firstChild.length > 0) {
    const leadingLength = leadingExternalLinkTextLength(firstChild);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon host={host} />
          {firstChild.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(firstChild.slice(leadingLength))}
        {childNodes.slice(1)}
      </>
    );
  }

  return (
    <>
      <span className="whitespace-nowrap">
        <MarkdownLinkFavicon host={host} />
        {firstChild}
      </span>
      {childNodes.slice(1)}
    </>
  );
}

function MarkdownFileChipContent({ label }: { label: ReadonlyArray<string> }) {
  return (
    <>
      <FileIcon aria-hidden className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>
        <Spaced parts={label} />
      </span>
    </>
  );
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  targetPath,
  panelPath,
  line,
  label,
  copyMarkdown,
  onOpenFile,
  className,
}: MarkdownFileLinkProps) {
  const openPath = onOpenFile && panelPath ? panelPath : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          openPath ? (
            <button
              type="button"
              className={cn(
                CHAT_FILE_TAG_CHIP_CLASS_NAME,
                MARKDOWN_FILE_LINK_CLASS_NAME,
                className,
              )}
              data-markdown-copy={copyMarkdown}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenFile?.(openPath, line);
              }}
            >
              <MarkdownFileChipContent label={label} />
            </button>
          ) : (
            <span
              className={cn(
                CHAT_FILE_TAG_CHIP_CLASS_NAME,
                MARKDOWN_FILE_CHIP_CLASS_NAME,
                "select-text",
                className,
              )}
              data-markdown-copy={copyMarkdown}
            >
              <MarkdownFileChipContent label={label} />
            </span>
          )
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        {/* The full path: the chip already shows the shortened form, and a link
            to the workspace root collapses to a bare label that repeats it. */}
        <div className="overflow-x-auto whitespace-nowrap [scrollbar-color:color-mix(in_srgb,var(--border)_78%,transparent)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--border)_78%,transparent)] [&::-webkit-scrollbar-track]:bg-transparent">
          {targetPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.targetPath === next.targetPath &&
    previous.displayPath === next.displayPath &&
    previous.panelPath === next.panelPath &&
    previous.line === next.line &&
    previous.label.join("\n") === next.label.join("\n") &&
    previous.copyMarkdown === next.copyMarkdown &&
    previous.onOpenFile === next.onOpenFile &&
    previous.className === next.className
  );
}

function ChatMarkdown({
  text,
  cwd: givenCwd,
  onTaskListChange: givenTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  className,
  lineBreaks = false,
  parseRawHtml = true,
  imageBaseDir: givenImageBaseDir,
  onImageExpand: givenImageExpand,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  resolvedTheme,
  wordWrap = true,
  onOpenFile: givenOpenFile,
  restricted = false,
}: ChatMarkdownProps) {
  // A restricted file is resolved against no folder and opens nothing of this computer's.
  const cwd = restricted ? undefined : givenCwd;
  const imageBaseDir = restricted ? undefined : givenImageBaseDir;
  const onTaskListChange = restricted ? undefined : givenTaskListChange;
  const onImageExpand = restricted ? undefined : givenImageExpand;
  const onOpenFile = restricted ? undefined : givenOpenFile;
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    if (restricted) return metaByHref;
    for (const href of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, imageBaseDir, restricted, text]);
  const inlineCodeFileLinkMetaByText = useMemo(() => {
    const metaByText = new Map<string, MarkdownFileLinkMeta>();
    if (restricted) return metaByText;
    for (const span of extractInlineCodeSpans(text)) {
      if (metaByText.has(span)) continue;
      const meta = resolveInlineCodeFileLinkMeta(span, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByText.set(span, meta);
      }
    }
    return metaByText;
  }, [cwd, imageBaseDir, restricted, text]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [
      ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
      ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
    ];
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [inlineCodeFileLinkMetaByText, markdownFileLinkMetaByHref]);
  const markdownUrlTransform = useCallback(
    (href: string) => {
      if (restricted) return defaultUrlTransform(href);
      if (isWindowsDrivePathHref(href)) return href;
      return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
    },
    [restricted],
  );
  // Re-emit highlighted content as markdown so copying out of the rendered
  // view keeps links, emphasis, lists, and code fences intact.
  const handleCopy = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
  }, []);
  /* eslint-disable react/no-unstable-nested-components -- ReactMarkdown requires component
   * renderers that close over this message's metadata. useMemo keeps them stable until that
   * metadata changes. */
  const markdownComponents = useMemo<Components>(() => {
    const fileLinkChip = (
      fileLinkMeta: MarkdownFileLinkMeta,
      copyMarkdown: string,
      className?: string,
      options?: { readonly inert?: boolean },
    ) => {
      const parentSuffix = fileLinkParentSuffixByPath.get(
        fileLinkMeta.filePath.replaceAll("\\", "/"),
      );
      const labelParts = [fileLinkMeta.basename];
      if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
        labelParts.push(parentSuffix);
      }
      if (fileLinkMeta.line) {
        labelParts.push(
          `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
        );
      }
      // Host files outside the workspace (a report in a temp dir) open by
      // their absolute path.
      const panelPath =
        fileLinkMeta.workspaceRelativePath ??
        (isAbsolutePath(fileLinkMeta.filePath) ? fileLinkMeta.filePath : null);

      return (
        <MarkdownFileLink
          targetPath={fileLinkMeta.targetPath}
          displayPath={fileLinkMeta.displayPath}
          panelPath={panelPath}
          line={fileLinkMeta.line}
          label={labelParts}
          copyMarkdown={copyMarkdown}
          onOpenFile={options?.inert ? undefined : onOpenFile}
          className={className}
        />
      );
    };

    return {
      p({ node: _node, children, ...props }) {
        return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
      },
      blockquote({ node: _node, children, ...props }) {
        const alert =
          GITHUB_ALERT_PRESENTATIONS[
            String((props as Record<string, unknown>)["data-alert"] ?? "")
          ];
        if (!alert) {
          return <blockquote {...props}>{children}</blockquote>;
        }
        // Not a <blockquote>: the stylesheet mutes those, and an alert's body is ordinary
        // text under a colored title, which is how the host renders it.
        return (
          <div role="note" className={cn("my-1 border-l-2 pl-3", alert.borderClassName)}>
            <p className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}>
              <alert.Icon aria-hidden className="size-3.5 shrink-0" />
              {alert.label}
            </p>
            {children}
          </div>
        );
      },
      ol({ node, start, style, ...props }) {
        const itemCount =
          node?.children?.filter((child) => child.type === "element" && child.tagName === "li")
            .length ?? 0;
        const gutterStyle = orderedListGutterStyle(itemCount, start);
        return (
          <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
        );
      },
      li({ node, children, ...props }) {
        const listItemStart = node?.position?.start.offset;
        const markerOffset =
          typeof listItemStart === "number" ? findTaskListMarkerOffset(text, listItemStart) : null;
        return (
          <li {...props} data-task-marker-offset={markerOffset ?? undefined}>
            {renderSkillInlineMarkdownChildren(children, skills)}
          </li>
        );
      },
      input({ node: _node, type, checked, disabled: _disabled, ...props }) {
        if (type !== "checkbox" || !onTaskListChange) {
          return (
            <input
              {...props}
              type={type}
              checked={checked}
              disabled={_disabled}
              readOnly={type === "checkbox"}
            />
          );
        }
        return (
          <input
            {...props}
            type="checkbox"
            name="markdown-task"
            aria-label="Toggle task"
            checked={checked}
            onChange={(event) => {
              const markerOffset = Number(
                event.currentTarget.closest("li")?.dataset.taskMarkerOffset,
              );
              if (!Number.isSafeInteger(markerOffset)) return;
              onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
            }}
          />
        );
      },
      a({ node, href, children, title: _title, ...props }) {
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        const fileLinkMeta =
          normalizedHref && !restricted
            ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
              resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd))
            : null;
        if (!fileLinkMeta) {
          const webHost = resolveExternalWebLinkHost(href);
          // A restricted file's page draws no favicon: that is an image fetched from Google naming the host.
          const faviconHost = restricted ? null : webHost;
          const isSameDocumentLink = href?.startsWith("#") ?? false;
          const onClick = props.onClick;
          const linkChildren = <MarkdownLinkContext value>{children}</MarkdownLinkContext>;
          const link = (
            <a
              {...props}
              href={href}
              target={isSameDocumentLink ? undefined : "_blank"}
              rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
              onClick={(event) => {
                onClick?.(event);
                if (isSameDocumentLink && href) {
                  handleMarkdownFragmentClick(event, href);
                }
              }}
            >
              {faviconHost && hastHasText(node) ? (
                <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
                  {linkChildren}
                </MarkdownExternalLinkContent>
              ) : (
                linkChildren
              )}
            </a>
          );
          if (!webHost || !href) {
            return link;
          }
          return (
            <Tooltip>
              <TooltipTrigger render={link} />
              <TooltipPopup
                side="top"
                className="max-w-[min(36rem,calc(100vw-2rem))] whitespace-normal leading-tight wrap-anywhere"
              >
                {href}
              </TooltipPopup>
            </Tooltip>
          );
        }

        return fileLinkChip(
          fileLinkMeta,
          `[${fileLinkMeta.basename}](${normalizedHref})`,
          props.className,
        );
      },
      code({ node, children, className, ...props }) {
        if (!restricted && node?.properties?.dataInlineCode != null) {
          const codeText = nodeToPlainText(children);
          const fileLinkMeta =
            inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
            resolveInlineCodeFileLinkMeta(codeText, cwd, imageBaseDir ?? cwd);
          if (fileLinkMeta) {
            return fileLinkChip(fileLinkMeta, `\`${codeText}\``);
          }
        }
        return (
          <code {...props} className={className}>
            {children}
          </code>
        );
      },
      img: function MarkdownImage({ node, title, src, alt, ...props }) {
        if (restricted) {
          return (
            <span data-k="skill-image" className={RESTRICTED_FACT_CLASS.join(" ")}>
              {[alt, typeof src === "string" ? src : ""].filter(Boolean).join(" ")}
            </span>
          );
        }
        const imageExpand = use(MarkdownLinkContext) ? undefined : onImageExpand;
        const localSrc = node?.properties?.dataLocalSrc;
        const markdownTitle = node?.properties?.dataMarkdownTitle;
        const authoredSrc = typeof localSrc === "string" ? localSrc : src;
        const authoredTitle = typeof markdownTitle === "string" ? markdownTitle : title;
        const srcString =
          typeof authoredSrc === "string" ? normalizeMarkdownLinkDestination(authoredSrc) : "";
        const classifiedSrc =
          typeof localSrc === "string" ? srcString.replaceAll("\\", "/") : srcString;
        const altText = alt ?? "";
        const copyMarkdown = markdownImageCopy(altText, srcString, authoredTitle);
        const authoredSizeStyle = authoredImageSizeStyle(props.width, props.height);
        const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
        const kind = mediaKindFromPath(classifiedSrc) ?? "image";
        if (imageSource._tag === "Direct") {
          if (kind === "video") {
            return (
              <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind="video" />
            );
          }
          const mediaSrc = resolveProtocolRelativeMediaUrl(imageSource.uri);
          const originalUrl =
            resolveExternalWebLinkHost(imageSource.uri) !== null ? imageSource.uri : undefined;
          return (
            <img
              {...props}
              src={mediaSrc}
              alt={altText}
              data-markdown-copy={copyMarkdown}
              loading="lazy"
              className={cn(
                props.className,
                CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
                imageExpand && "cursor-zoom-in",
              )}
              style={authoredSizeStyle}
              {...expandableMarkdownImageProps(imageExpand, mediaSrc, altText, originalUrl)}
            />
          );
        }
        if (imageSource._tag === "WorkspaceFile") {
          const fileLinkMeta = resolveMarkdownFileLinkMeta(imageSource.path, cwd, imageBaseDir ?? cwd);
          if (fileLinkMeta) {
            return fileLinkChip(fileLinkMeta, copyMarkdown, undefined, { inert: true });
          }
        }
        return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind={kind} />;
      },
      table({ node: _node, ...props }) {
        return <MarkdownTable {...props} wordWrap={wordWrap} />;
      },
      details({ node: _node, children, open: detailsOpen }) {
        return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
      },
      pre({ node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        const language = extractFenceLanguage(codeBlock.className);
        const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
        return (
          <MarkdownCodeBlock
            code={codeBlock.code}
            language={language}
            fenceTitle={fenceTitle}
            wordWrap={wordWrap}
          >
            <RenderErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                />
              </Suspense>
            </RenderErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
    };
  }, [
    cwd,
    diffThemeName,
    fileLinkParentSuffixByPath,
    inlineCodeFileLinkMetaByText,
    imageBaseDir,
    isStreaming,
    markdownFileLinkMetaByHref,
    onTaskListChange,
    onImageExpand,
    onOpenFile,
    restricted,
    skills,
    text,
    wordWrap,
  ]);
  /* eslint-enable react/no-unstable-nested-components */

  const remarkPlugins = useMemo(
    () =>
      restricted
        ? SKILL_MARKDOWN_REMARK_PLUGINS
        : [
            ...(lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS),
            ...extraRemarkPlugins,
          ],
    [extraRemarkPlugins, lineBreaks, restricted],
  );

  // react-markdown converts unparsed HTML nodes to text when skipHtml is false.
  // Keep that behavior explicit because literal mode depends on escaping the
  // complete source token instead of dropping it from the rendered message.
  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere] [word-break:break-word]",
        className,
      )}
      onCopy={handleCopy}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={restricted ? SKILL_MARKDOWN_REHYPE_PLUGINS : parseRawHtml ? CHAT_MARKDOWN_REHYPE_PLUGINS : undefined}
        skipHtml={false}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
