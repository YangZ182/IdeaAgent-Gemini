"use client";

import { useState, useRef, useCallback, useMemo, useEffect, type ReactNode, type RefObject } from "react";
import { Box, Button, Flex, Heading, Link, Spinner, Center, Text, Stack, chakra } from "@chakra-ui/react";
import { motion, useMotionValue } from "motion/react";
import { useConversationData } from "@/hooks/useConversationData";
import { usePlaybackState } from "@/hooks/usePlaybackState";
import { useProgressToast } from "@/hooks/useProgressToast";
import { useInsightVisibility } from "@/hooks/useInsightVisibility";
import { useDemoCaptions } from "@/hooks/useDemoCaptions";
import { PlaybackControls } from "@/components/PlaybackControls";
import { InsightsSidebar } from "@/components/InsightsSidebar";
import { ProgressToast } from "@/components/ProgressToast";
import { InsightBanner } from "@/components/InsightBanner";
import { joinConversationV2, leaveConversationV2 } from "@/services/v2Api";
import { useOnboarding } from "@/hooks/useOnboarding";
import { OnboardingTour } from "@/components/OnboardingTour";
import type { DismissedInsight } from "@/types";
import type { InsightBannerState } from "@/types/progressToast";

const NOTIFICATION_WIDTH = 400;
const DRAG_DISMISS_RATIO = 0.4;

// Fill these training messages for read-only demo chat (2 user + 1 assistant suggested).
const DEMO_CHAT_PRESET_MESSAGES: Array<{ role: "user" | "assistant"; content: string }> = [
  { role: "user", content: "Which sectors and provinces are driving Canada's emissions increase since 1990?" },
  { role: "assistant", content: "Alberta's oil and gas sector is the dominant driver — bitumen extraction has expanded massively since 1990, and volume growth has outpaced efficiency gains. Saskatchewan's heavy industry and agriculture contribute as well. Transportation is the second-largest national driver, growing steadily across all provinces due to increased freight and personal vehicle use. Ontario and Quebec have actually reduced emissions, largely because their electricity grids were already low-carbon. The short answer is that Canada's emissions problem is heavily concentrated in western fossil fuel production." },
  { role: "user", content: "Can you give me more details on the transportation emissions?" },
  { role: "assistant", content: "Transportation emissions have increased by about 40% since 1990, making it the second-largest source of emissions in Canada. The growth is driven by both freight and passenger transportation. Freight transportation has expanded due to increased trade and e-commerce, leading to more trucks on the road. Personal vehicle use has also increased, with more Canadians owning cars and driving longer distances. While there have been improvements in fuel efficiency, they haven't kept pace with the growth in transportation activity. This trend is consistent across all provinces, but it's particularly pronounced in Ontario and Quebec, which have large urban centers and significant commuter traffic." },
];

interface AnimatedNotificationItemProps {
  lifecycle: "active" | "exiting";
  width: number;
  cancelClickOnDrag?: boolean;
  onRequestDismiss: () => void;
  onFinalizeDismiss: () => void;
  children: ReactNode;
}

function AnimatedNotificationItem({
  lifecycle,
  width,
  cancelClickOnDrag = false,
  onRequestDismiss,
  onFinalizeDismiss,
  children,
}: AnimatedNotificationItemProps) {
  const x = useMotionValue(0);
  const [didDrag, setDidDrag] = useState(false);

  return (
    <motion.div
      style={{
        x,
        width: `${width}px`,
        pointerEvents: lifecycle === "exiting" ? "none" : "auto",
      }}
      initial={{ opacity: 0, x: 80, scale: 0.98 }}
      animate={lifecycle === "exiting"
        ? { opacity: 0, x: 120, scale: 0.98 }
        : { opacity: 1, x: 0, scale: 1 }}
      transition={lifecycle === "exiting"
        ? { duration: 0.26, ease: [0.4, 0, 1, 1] }
        : { type: "spring", stiffness: 260, damping: 30, mass: 1.0 }}
      drag="x"
      dragMomentum={false}
      dragElastic={0.3}
      dragConstraints={{ left: 0, right: 0 }}
      onDrag={(_, info) => {
        if (info.offset.x < 0) {
          x.set(0);
          return;
        }

        if (info.offset.x > 6) {
          setDidDrag(true);
        }
      }}
      onDragEnd={(_, info) => {
        if (info.offset.x >= width * DRAG_DISMISS_RATIO) {
          onRequestDismiss();
          return;
        }

        setDidDrag(false);
      }}
      onClickCapture={(event) => {
        if (cancelClickOnDrag && didDrag) {
          event.preventDefault();
          event.stopPropagation();
          setDidDrag(false);
        }
      }}
      onAnimationComplete={() => {
        if (lifecycle === "exiting") {
          onFinalizeDismiss();
        }
      }}
    >
      {children}
    </motion.div>
  );
}

interface DemoAppProps {
  onBack?: () => void;
}

const ideaApi = "/api/idea-agent";
const demoAudio = `${ideaApi}/samples/${encodeURIComponent("00 加拿大会议 - 完整录音.m4a")}`;

interface SpeakerMatch {
  status: "ready" | "uncalibrated" | "unavailable";
  contacts: { id: string; name: string }[];
  speakers: {
    label: string; start: number | null; can_register: boolean; registered_id: string | null;
    candidate_id: string | null; score: number | null; matched: boolean;
  }[];
  viewers: { id: string; name: string }[];
}

function SpeakerPanel({ resultPath, play }: { resultPath: string; play: (time: number) => void }) {
  const [matches, setMatches] = useState<SpeakerMatch>();
  const [label, setLabel] = useState("");
  const [contact, setContact] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = `${resultPath}/speakers`;

  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error();
      setMatches(await response.json());
    }).catch(() => {
      if (!controller.signal.aborted) setError("声纹匹配不可用。");
    });
    return () => controller.abort();
  }, [url]);

  const change = async (action: "register" | "revoke" | "rename" | "refresh") => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Idea-Agent": "1" },
        body: JSON.stringify({ action, label, contact_id: contact || null, name: name.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "操作失败。");
      setMatches(data);
      setLabel("");
      setContact("");
      setName("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  };

  const contactName = (id: string | null) => matches?.contacts.find((item) => item.id === id)?.name;
  const viewers = matches?.viewers.map(({ name }) => name).join("、");
  return (
    <Box as="details" borderWidth="1px" borderRadius="md" px="2" py="1" maxW="100%">
      <chakra.summary cursor="pointer">
        报告可查看人员（本地名单） · {matches ? viewers || "暂无确认人员" : error ? "暂时无法读取" : "读取中…"}
      </chakra.summary>
      <Stack gap="2" mt="2" maxH="42vh" overflowY="auto" pr="1">
        {error && <Text role="alert">{error}</Text>}
        {!matches && !error && <Text>正在读取匹配结果…</Text>}
        {matches?.status === "unavailable" && <Text>此录音缺少声纹数据。</Text>}
        {matches?.status === "uncalibrated" && <Text>声纹匹配待校准，可回听后手动确认。</Text>}
        {matches?.speakers.map((speaker) => (
          <Flex key={speaker.label} gap="2" align="center" wrap="wrap">
            <Text fontSize="sm">
              {speaker.label} · {speaker.registered_id ? `已确认：${contactName(speaker.registered_id)}` :
                speaker.matched ? `待确认：${contactName(speaker.candidate_id)}` : "待确认：未知"}
              {!speaker.registered_id && speaker.matched && speaker.score !== null &&
                ` · 相似度 ${speaker.score.toFixed(3)}`}
            </Text>
            {speaker.start !== null && (
              <Button size="xs" variant="ghost" onClick={() => play(speaker.start!)}>
                回听 {Math.floor(speaker.start / 60)}:{String(Math.floor(speaker.start % 60)).padStart(2, "0")}
              </Button>
            )}
            {speaker.can_register && (
              <Button size="xs" variant="outline" disabled={busy} onClick={() => {
                setLabel(speaker.label);
                const candidate = speaker.registered_id ?? (speaker.matched ? speaker.candidate_id : null);
                setContact(candidate ?? "");
                setName(contactName(candidate) ?? "");
              }}>{speaker.registered_id ? "修改确认" : "确认人员"}</Button>
            )}
          </Flex>
        ))}
        {label && (
          <Stack gap="2" aria-label={`确认 ${label}`}>
            <Text fontSize="sm">回听并确认 {label} 的身份</Text>
            <Flex gap="2" wrap="wrap">
              <chakra.select aria-label="联系人" borderWidth="1px" px="2" value={contact} disabled={busy}
                onChange={(event) => { setContact(event.target.value); setName(contactName(event.target.value) ?? ""); }}>
                <option value="">新建联系人</option>
                {matches?.contacts.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </chakra.select>
              <chakra.input aria-label="联系人名称" placeholder="联系人名称" borderWidth="1px" px="2"
                value={name} maxLength={100} disabled={busy} onChange={(event) => setName(event.target.value)} />
              <Button size="xs" disabled={busy || (!contact && !name.trim())}
                onClick={() => void change("register")}>确认并加入名单</Button>
              {contact && <Button size="xs" disabled={busy || !name.trim() || name.trim() === contactName(contact)}
                onClick={() => void change("rename")}>更新姓名</Button>}
              {matches?.speakers.some((speaker) => speaker.label === label && speaker.registered_id) &&
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void change("revoke")}>撤销确认</Button>}
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => setLabel("")}>取消</Button>
            </Flex>
          </Stack>
        )}
        {matches && matches.status !== "unavailable" && (
          <Button alignSelf="start" size="xs" variant="outline" disabled={busy}
            onClick={() => void change("refresh")}>重新比对</Button>
        )}
      </Stack>
    </Box>
  );
}

interface IdeaStatus {
  phase: "idle" | "running" | "done" | "partial" | "error";
  message: string;
  result: string | null;
}

type ReportView = { mode: "latest" | "preview" } | { mode: "submitted"; jobId: string };

export default function App({ onBack }: DemoAppProps) {
  const [status, setStatus] = useState<IdeaStatus>({ phase: "idle", message: "", result: null });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [samples, setSamples] = useState<string[]>([]);
  const [selectedSample, setSelectedSample] = useState("");
  const [view, setView] = useState<ReportView>({ mode: "latest" });
  const fileInput = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const visibleResult = view.mode === "latest" || (view.mode === "submitted" && view.jobId === status.result)
    ? status.result : null;
  const resultPath = visibleResult ? `${ideaApi}/result/${visibleResult}` : undefined;
  const previewing = view.mode !== "latest" && !resultPath;
  const selectedAudio = selectedSample
    ? `${ideaApi}/samples/${encodeURIComponent(selectedSample)}`
    : undefined;
  const busy = uploading || status.phase === "running";

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(`${ideaApi}/status`, { signal: controller.signal, cache: "no-store" });
        if (response.ok) {
          const next: IdeaStatus = await response.json();
          if (!controller.signal.aborted) setStatus(next);
        }
      } catch {
        // The bundled demo also runs without the local processing service.
      }
    };
    void fetch(`${ideaApi}/samples`, { signal: controller.signal })
      .then(async (response) => {
        if (response.ok && !controller.signal.aborted) setSamples(await response.json());
      })
      .catch(() => {});
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const upload = async (recording: File | string) => {
    setUploading(true);
    setUploadError("");
    setView({ mode: "preview" });
    if (typeof recording !== "string") setSelectedSample("");
    try {
      const form = new FormData();
      if (typeof recording === "string") {
        const sample = await fetch(`${ideaApi}/samples/${encodeURIComponent(recording)}`);
        if (!sample.ok) throw new Error("读取会议样本失败。");
        form.append("file", await sample.blob(), recording);
      } else {
        form.append("file", recording);
      }
      const response = await fetch(`${ideaApi}/upload`, {
        method: "POST", headers: { "X-Idea-Agent": "1" }, body: form,
      });
      const update = await response.json();
      if (!response.ok) throw new Error(update.detail || "上传失败。");
      setView({ mode: "submitted", jobId: update.job_id });
      setStatus((previous) => previous.result === update.job_id ? previous :
        { ...previous, phase: update.phase, message: update.message });
    } catch (error) {
      setUploadError(error instanceof Error && !(error instanceof SyntaxError) && !(error instanceof TypeError)
        ? error.message : "无法连接本机录音处理服务。");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Flex direction="column" height="100dvh">
      <Stack align="start" gap="1" px="4" py="2" bg="bg" borderBottomWidth="1px">
        <Heading as="h1" size="sm">IdeaAgent</Heading>
        <Flex align="center" gap="3" wrap="wrap">
          <input hidden type="file" accept=".wav,.mp3,.m4a" ref={fileInput} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void upload(file);
          }} />
          <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
            上传录音
          </Button>
          {resultPath && <Link href={`${resultPath}/report.md`}>下载 Markdown</Link>}
          {resultPath && <SpeakerPanel key={resultPath} resultPath={resultPath} play={(time) => {
            const audio = audioRef.current;
            if (audio) {
              audio.currentTime = time;
              void audio.play().catch(() => {});
            }
          }} />}
        </Flex>
        {samples.length > 0 && (
          <Flex align="center" gap="2" wrap="wrap">
            <chakra.select aria-label="会议样本" maxW="100%" minH="8" px="2" borderWidth="1px"
              borderRadius="md" bg="bg" color="fg" value={selectedSample} disabled={uploading}
              onChange={(event) => {
                const sample = event.target.value;
                setSelectedSample(sample);
                setView({ mode: sample ? "preview" : "latest" });
                setUploadError("");
              }}>
              <option value="">选择会议样本</option>
              {samples.map((sample) => <option key={sample} value={sample}>{sample.replace(/\.[^.]+$/, "")}</option>)}
            </chakra.select>
            <Button size="sm" variant="outline" disabled={busy || !selectedSample} onClick={() => void upload(selectedSample)}>
              运行样本
            </Button>
          </Flex>
        )}
        <Text fontSize="xs" color="fg.muted">音频留在本机，逐字稿发送给 DeepSeek。</Text>
        <Text fontSize="sm" role="status">
          {uploadError || (uploading ? "正在上传…" : view.mode !== "preview" ? status.message :
            status.phase === "running" ? "后台有录音正在处理，当前样本可试听。" : "")}
        </Text>
      </Stack>
      <Box flex="1" minH="0" position="relative">
        {previewing ? (
          <Center height="100%" px="4">
            {selectedAudio && <chakra.audio key={selectedAudio} src={selectedAudio} aria-label="会议录音"
              controls preload="metadata" w="100%" maxW="520px" />}
          </Center>
        ) : <DemoReplay key={resultPath ?? "sample"} onBack={onBack} resultPath={resultPath} audioRef={audioRef} />}
      </Box>
    </Flex>
  );
}

function DemoReplay({ onBack, resultPath, audioRef }: DemoAppProps & {
  resultPath?: string; audioRef: RefObject<HTMLAudioElement | null>;
}) {
  const {
    chunks,
    topics,
    insights,
    meetingTitle,
    meetingSummary,
    chunkToTopicMap,
    insightToChunkMap,
    topicToChunksMap,
    events,
    isLoading,
    error,
  } = useConversationData(resultPath ? `${resultPath}/input.json` : undefined);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(!resultPath);
  const [isCcEnabled, setIsCcEnabled] = useState(false);
  const [demoSession, setDemoSession] = useState<{ conversationId: string; clientId: string } | null>(null);
  const [isDemoSessionReady, setIsDemoSessionReady] = useState(false);

  // New state for features
  const [selectedInsightId, setSelectedInsightId] = useState<string | null>(null);
  const [pinnedInsightIds, setPinnedInsightIds] = useState<Set<string>>(new Set());
  const [dismissedInsights, setDismissedInsights] = useState<DismissedInsight[]>([]);
  const [isTranscriptSidebarOpen, setIsTranscriptSidebarOpen] = useState(false);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [focusInsightRequest, setFocusInsightRequest] = useState<{ insightId: string; topicId: string | null; requestId: number } | null>(null);

  // Page load time for timestamp calculation (simulates real-time)
  const [pageLoadTime] = useState(() => new Date());

  const demoSessionRef = useRef<{ conversationId: string; clientId: string } | null>(null);
  const leavingRef = useRef(false);

  useEffect(() => {
    demoSessionRef.current = demoSession;
  }, [demoSession]);

  useEffect(() => {
    let isCancelled = false;
    const envConversationId = resultPath ? "" : (import.meta.env.VITE_DEMO_ID as string | undefined)?.trim() ?? "";

    const joinDemoSession = async () => {
      if (!envConversationId) {
        setIsDemoSessionReady(false);
        return;
      }

      try {
        const joined = await joinConversationV2({
          conversationId: envConversationId,
          speakerName: "Demo User",
          isBaseline: false,
        });

        if (isCancelled) return;

        const nextSession = {
          conversationId: joined.conversation_id,
          clientId: joined.client_id,
        };
        demoSessionRef.current = nextSession;
        setDemoSession(nextSession);
        setIsDemoSessionReady(true);
      } catch {
        if (isCancelled) return;
        demoSessionRef.current = null;
        setDemoSession(null);
        setIsDemoSessionReady(false);
      }
    };

    void joinDemoSession();

    return () => {
      isCancelled = true;
    };
  }, [resultPath]);

  // Onboarding tour hook — must be before useProgressToast so signals are available
  const onboarding = useOnboarding({ isReady: false });

  // Progress toast hook for showing insight generation progress
  const {
    activeToasts,
    insightBanners,
    dismissToast,
    dismissBanner,
    finalizeDismissToast,
    finalizeDismissBanner,
    simulateChunkEvents,
    advanceProgressStage,
    resetProgressState,
  } = useProgressToast({
    topics,
    pauseAutoDismiss: onboarding.signals.shouldPauseBannerDismiss,
    pauseProgressSimulation: onboarding.signals.shouldPauseBannerDismiss,
    onStageChange: onboarding.handleProgressStageChange,
    onBannerCreated: onboarding.handleBannerCreated,
  });

  // Insight visibility tracking for seen/unseen state
  const {
    seenInsightIds,
    registerRef: registerInsightRef,
    getUnseenCount,
    getElement: getInsightElement,
  } = useInsightVisibility();

  const { visibleState, loadingInsights, highlights, visibleChunkIndices, processingChunkIndices } = usePlaybackState({
    chunks,
    topics,
    insights,
    meetingTitle,
    meetingSummary,
    chunkToTopicMap,
    currentTime,
    isPlaying,
    // Trigger progress toast simulation when a chunk starts processing
    onChunkProcessingStart: resultPath ? undefined : simulateChunkEvents,
    onPlaybackReset: resetProgressState,
  });

  const handleSeek = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  }, []);

  const handlePlayPause = useCallback(() => {
    if (audioRef.current) {
      if (audioRef.current.paused) {
        audioRef.current.play();
      } else {
        audioRef.current.pause();
      }
    }
  }, []);

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  const handleDurationChange = useCallback((dur: number) => {
    setDuration(dur);
  }, []);

  const handlePlayStateChange = useCallback((playing: boolean) => {
    setIsPlaying(playing);
  }, []);

  // Pin/Dismiss handlers
  const handlePinInsight = useCallback((insightId: string) => {
    setPinnedInsightIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(insightId)) {
        newSet.delete(insightId);
      } else {
        newSet.add(insightId);
      }
      return newSet;
    });
  }, []);

  const displayedInsights = resultPath ? insights : visibleState.insights;
  const handleDismissInsight = useCallback((insightId: string, topicId: string, topicName: string) => {
    const insight = displayedInsights.find((i) => i.id === insightId);
    if (!insight) return;

    setDismissedInsights((prev) => [
      ...prev,
      {
        insight,
        originalTopicId: topicId,
        topicName,
        dismissedAt: Date.now(),
      },
    ]);
  }, [displayedInsights]);

  const handleRestoreInsight = useCallback((insightId: string) => {
    setDismissedInsights((prev) => prev.filter((d) => d.insight.id !== insightId));
  }, []);

  // Filter out dismissed insights from visible insights
  const dismissedIds = new Set(dismissedInsights.map((d) => d.insight.id));
  const activeInsights = displayedInsights.filter((i) => !dismissedIds.has(i.id));
  const displayedChunkIndices = useMemo(() => resultPath
    ? new Set(chunks.map((chunk) => chunk.chunk_index))
    : visibleChunkIndices, [resultPath, chunks, visibleChunkIndices]);

  const activeProgressChunkIndices = useMemo(() => {
    return new Set(
      activeToasts
        .filter((toast) => toast.stage !== "complete")
        .map((toast) => toast.chunkIndex)
    );
  }, [activeToasts]);

  const shouldGateByProgress =
    activeProgressChunkIndices.size > 0 || processingChunkIndices.size > 0;

  const blockedChunkIndices = useMemo(() => {
    return new Set([
      ...activeProgressChunkIndices,
      ...processingChunkIndices,
    ]);
  }, [activeProgressChunkIndices, processingChunkIndices]);

  const gatedInsights = useMemo(() => {
    if (!shouldGateByProgress) return activeInsights;

    return activeInsights.filter((insight) => {
      if (focusInsightRequest?.insightId === insight.id) {
        return true;
      }

      const chunkIndex = insightToChunkMap.get(insight.id);
      if (chunkIndex === undefined) return true;
      return !blockedChunkIndices.has(chunkIndex);
    });
  }, [activeInsights, shouldGateByProgress, focusInsightRequest, insightToChunkMap, blockedChunkIndices]);

  const gatedLoadingInsights = useMemo(() => {
    if (!shouldGateByProgress) return loadingInsights;

    return loadingInsights.filter((item) => {
      const chunkIndex = insightToChunkMap.get(item.insightId);
      if (chunkIndex === undefined) return true;
      return !blockedChunkIndices.has(chunkIndex);
    });
  }, [loadingInsights, shouldGateByProgress, insightToChunkMap, blockedChunkIndices]);

  // Citation click handler
  const handleCitationClick = useCallback((url: string) => {
    setActiveUrl(url);
    setIsTranscriptSidebarOpen(true);
    // Notify onboarding that a citation was clicked
    onboarding.handleCitationClicked();
  }, [onboarding]);

  const handleToggleCc = useCallback(() => {
    setIsCcEnabled((prev) => {
      const next = !prev;
      onboarding.handleCcToggled(next);
      return next;
    });
  }, [onboarding]);

  const handleCloseSourcePreview = useCallback(() => {
    setActiveUrl(null);
    onboarding.handleSidebarOnboardingEvent({ type: "source-preview-closed" });
  }, [onboarding]);

  const handleSelectInsight = useCallback((insightId: string | null) => {
    setSelectedInsightId(insightId);
  }, []);

  const handleExpandFromBanner = useCallback((banner: InsightBannerState) => {
    const insightType = banner.insight.type === "viz" ? "viz" : "text";

    if (onboarding.phase === "insight-banners" && insightType === "text") {
      activeToasts.forEach((toast) => {
        if (toast.lifecycle === "active") {
          dismissToast(toast.id);
        }
      });
      insightBanners.forEach((item) => {
        if (item.lifecycle === "active") {
          dismissBanner(item.id);
        }
      });
    }

    setIsSidebarCollapsed(false);
    setFocusInsightRequest({
      insightId: banner.insight.id,
      topicId: banner.topicId ?? banner.insight.thread?.topic_id ?? null,
      requestId: Date.now(),
    });
    // Notify onboarding that a banner was clicked
    onboarding.handleBannerClicked(insightType as "text" | "viz");
  }, [activeToasts, dismissBanner, dismissToast, insightBanners, onboarding]);

  const sidebarWidth = isSidebarCollapsed
    ? 48 + (isTranscriptSidebarOpen ? 350 : 0)
    : 450 + (isTranscriptSidebarOpen ? 350 : 0);
  const overlayRight = isSidebarCollapsed
    ? "48px"
    : `${450 + (isTranscriptSidebarOpen ? 350 : 0)}px`;

  const leaveDemoSession = useCallback(async () => {
    if (leavingRef.current) return;

    const current = demoSessionRef.current;
    if (!current) return;

    leavingRef.current = true;
    try {
      await leaveConversationV2({
        conversationId: current.conversationId,
        clientId: current.clientId,
      });
    } catch {
      // Best effort only for demo teardown.
    } finally {
      demoSessionRef.current = null;
      setDemoSession(null);
      setIsDemoSessionReady(false);
      leavingRef.current = false;
    }
  }, []);

  useEffect(() => {
    return () => {
      void leaveDemoSession();
    };
  }, [leaveDemoSession]);

  const handleLeaveClick = useCallback(async () => {
    await leaveDemoSession();
    onBack?.();
  }, [onBack, leaveDemoSession]);

  const { text: demoCaptionText, phase: demoCaptionPhase } = useDemoCaptions(
    chunks,
    currentTime,
    isCcEnabled,
  );

  // Onboarding: pause/resume video based on onboarding signals
  useEffect(() => {
    if (!audioRef.current) return;
    if (onboarding.signals.shouldPausePlayback) {
      audioRef.current.pause();
    }
  }, [onboarding.signals.shouldPausePlayback]);

  // Onboarding: auto-play video when "waiting-for-toast" phase begins
  useEffect(() => {
    if (onboarding.phase === "waiting-for-toast" && audioRef.current) {
      audioRef.current.play();
    }
  }, [onboarding.phase]);

  const { phase: onboardingPhase, handlePlaybackCheckpointReached } = onboarding;

  useEffect(() => {
    if (onboardingPhase !== "waiting-for-topic-checkpoint") {
      return;
    }

    const audioEl = audioRef.current;
    if (!audioEl) {
      return;
    }

    let didAdvance = false;
    const pauseAndAdvance = () => {
      if (didAdvance) return;
      didAdvance = true;
      audioEl.pause();
      handlePlaybackCheckpointReached();
    };

    // Lock the checkpoint from the current playback position once for this phase entry.
    const playbackNow = audioEl.currentTime;
    const nextChunkWithStart = chunks.find((chunk) => chunk.start_timestamp !== undefined && chunk.start_timestamp > playbackNow);
    if (!nextChunkWithStart) {
      // Near end-of-video there may be no future synced chunk; avoid dead-end in onboarding.
      pauseAndAdvance();
      return;
    }

    void audioEl.play();

    const checkpoint = nextChunkWithStart.start_timestamp;
    if (checkpoint === undefined) {
      pauseAndAdvance();
      return;
    }

    const timer = window.setInterval(() => {
      if (audioEl.currentTime >= checkpoint) {
        window.clearInterval(timer);
        pauseAndAdvance();
      }
    }, 120);

    return () => {
      window.clearInterval(timer);
    };
  }, [chunks, onboardingPhase, handlePlaybackCheckpointReached]);

  // Onboarding: after CC toggle, resume playback so regenerated insights can be generated.
  useEffect(() => {
    if (onboarding.phase !== "waiting-for-regenerated-insights") {
      return;
    }
    if (!audioRef.current || !audioRef.current.paused) {
      return;
    }
    audioRef.current.play();
  }, [onboarding.phase]);

  // Onboarding: in regenerated-insights auto mode, advance paused progress stages without Next clicks.
  useEffect(() => {
    if (onboarding.phase !== "regenerated-insights") {
      return;
    }

    if (onboarding.regeneratedInsightsMode !== "toast-progress") {
      return;
    }

    // Kick once immediately, then continue until mode transitions to toast-banners/sidebar-final.
    advanceProgressStage();
    const timer = window.setInterval(() => {
      advanceProgressStage();
    }, 1200);

    return () => {
      window.clearInterval(timer);
    };
  }, [advanceProgressStage, onboarding.phase, onboarding.regeneratedInsightsMode]);

  if (isLoading) {
    return (
      <Center height="100%" bg="bg">
        <Stack align="center" gap="4">
          <Spinner size="xl" color="blue.500" />
          <Text color="fg.muted">Loading conversation data...</Text>
        </Stack>
      </Center>
    );
  }

  if (error) {
    return (
      <Center height="100%" bg="bg">
        <Stack align="center" gap="4" maxW="400px" textAlign="center">
          <Text color="red.500" fontWeight="semibold">
            Error loading data
          </Text>
          <Text color="fg.muted" fontSize="sm">
            {error}
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Box height="100%" overflow="hidden" bg="bg">
      <Box display={{ base: "none", md: "block" }}>
        <PlaybackControls
          currentTime={currentTime}
          duration={duration}
          isPlaying={isPlaying}
          events={events}
          onSeek={handleSeek}
          onPlayPause={handlePlayPause}
          sidebarWidth={sidebarWidth}
        />
      </Box>

      {/* Main content area */}
      <Flex height="100%" direction={{ base: "column", md: "row" }}>
        <Box flex={{ base: "0 0 auto", md: "1" }} minW="0" data-onboarding="video-area">
          <Center height="100%" px="4" py={{ base: "2", md: "4" }}>
            <Stack w="100%" maxW="520px" align="stretch">
              <chakra.audio
                ref={audioRef}
                src={resultPath ? `${resultPath}/audio.m4a` : demoAudio}
                aria-label="会议录音"
                controls
                preload="metadata"
                w="100%"
                onTimeUpdate={(event) => handleTimeUpdate(event.currentTarget.currentTime)}
                onDurationChange={(event) => handleDurationChange(event.currentTarget.duration)}
                onPlay={() => handlePlayStateChange(true)}
                onPause={() => handlePlayStateChange(false)}
                onEnded={() => handlePlayStateChange(false)}
              />
              <Flex gap="2" wrap="wrap">
                <Button size="sm" variant="outline" aria-pressed={isCcEnabled} onClick={handleToggleCc}>
                  {isCcEnabled ? "关闭字幕" : "开启字幕"}
                </Button>
                {onBack && <Button size="sm" variant="ghost" onClick={() => void handleLeaveClick()}>返回</Button>}
              </Flex>
              {isCcEnabled && demoCaptionText && (
                <Text
                  fontSize="sm" textAlign="center" lineHeight="tall" px="3" py="2" borderRadius="md"
                  bg={demoCaptionPhase === "final" ? "bg.muted" : "bg.subtle"}
                >
                  {demoCaptionText}
                </Text>
              )}
            </Stack>
          </Center>
        </Box>

        {/* Insights sidebar */}
        <Box minH="0" flex={{ base: "1", md: "0 0 auto" }} overflow={{ base: "auto", md: "visible" }}>
        <InsightsSidebar
          topics={resultPath ? topics : visibleState.topics}
          insights={resultPath ? activeInsights : gatedInsights}
          loadingInsights={resultPath ? [] : gatedLoadingInsights}
          currentTopicId={visibleState.currentTopicId}
          highlights={highlights}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          pinnedInsightIds={pinnedInsightIds}
          onPinInsight={handlePinInsight}
          onDismissInsight={handleDismissInsight}
          dismissedInsights={dismissedInsights}
          onRestoreInsight={handleRestoreInsight}
          selectedInsightId={selectedInsightId}
          onSelectInsight={handleSelectInsight}
          onCitationClick={handleCitationClick}
          // Transcript sidebar props
          chunks={chunks}
          chunkToTopicMap={chunkToTopicMap}
          insightToChunkMap={insightToChunkMap}
          topicToChunksMap={topicToChunksMap}
          visibleChunkIndices={displayedChunkIndices}
          isTranscriptSidebarOpen={isTranscriptSidebarOpen}
          onToggleTranscriptSidebar={() => setIsTranscriptSidebarOpen(!isTranscriptSidebarOpen)}
          activeUrl={activeUrl}
          onCloseUrl={handleCloseSourcePreview}
          onSourcePreviewExpandChange={onboarding.handleSourcePreviewExpanded}
          pageLoadTime={pageLoadTime}
          focusInsightRequest={focusInsightRequest}
          onFocusHandled={() => setFocusInsightRequest(null)}
          // Seen tracking props
          seenInsightIds={seenInsightIds}
          registerInsightRef={registerInsightRef}
          getUnseenCount={getUnseenCount}
          getInsightElement={getInsightElement}
          isInteractiveTabsEnabled={!resultPath}
          conversationId={isDemoSessionReady ? demoSession?.conversationId ?? null : null}
          clientId={isDemoSessionReady ? demoSession?.clientId ?? null : null}
          isExplainEnabled={isDemoSessionReady}
          chatPresetMessages={DEMO_CHAT_PRESET_MESSAGES}
          isChatReadOnly
          onOnboardingEvent={onboarding.handleSidebarOnboardingEvent}
          onboardingPhase={onboarding.phase}
        />
        </Box>
      </Flex>

      {/* Progress toasts and generated insight banners - always shown as overlay for consistency */}
      {(activeToasts.length > 0 || insightBanners.length > 0) && (
        <Box
          data-onboarding="toast-container"
          position="absolute"
          top="4"
          right={overlayRight}
          zIndex="toast"
          display="flex"
          flexDirection="column"
          gap="2"
          maxH="calc(100vh - 32px)"
          overflowY="auto"
          pointerEvents="none"
          css={{
            scrollbarWidth: "none",
            "&::-webkit-scrollbar": { display: "none" },
          }}
        >
          {/* Progress toasts first */}
          {activeToasts.map((toast) => (
            <AnimatedNotificationItem
              key={toast.id}
              lifecycle={toast.lifecycle}
              width={NOTIFICATION_WIDTH}
              onRequestDismiss={() => dismissToast(toast.id)}
              onFinalizeDismiss={() => finalizeDismissToast(toast.id)}
            >
              <ProgressToast
                toast={toast}
                onDismiss={() => dismissToast(toast.id)}
              />
            </AnimatedNotificationItem>
          ))}
          {/* Insight banners below */}
          {insightBanners.map((banner) => (
            <AnimatedNotificationItem
              key={banner.id}
              lifecycle={banner.lifecycle}
              width={NOTIFICATION_WIDTH}
              cancelClickOnDrag
              onRequestDismiss={() => dismissBanner(banner.id)}
              onFinalizeDismiss={() => finalizeDismissBanner(banner.id)}
            >
              <InsightBanner
                banner={banner}
                onDismiss={() => dismissBanner(banner.id)}
                onExpand={handleExpandFromBanner}
              />
            </AnimatedNotificationItem>
          ))}
        </Box>
      )}

      {/* Onboarding tour overlay */}
      <OnboardingTour
        steps={onboarding.steps}
        stepIndex={onboarding.stepIndex}
        run={onboarding.run}
        onCallback={onboarding.handleJoyrideCallback}
        progressSubtext={onboarding.progressSubtext}
        onboardingPhase={onboarding.phase}
        regeneratedInsightsMode={onboarding.regeneratedInsightsMode}
        regeneratedInsightsSubtext={onboarding.regeneratedInsightsSubtext}
        onAdvanceProgress={advanceProgressStage}
      />
    </Box>
  );
}
