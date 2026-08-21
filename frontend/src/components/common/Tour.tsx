import React, { useState } from 'react';
import { IconChevronRight, IconClose, IconSparkles, IconCheck } from './Icons';

export interface TourStep {
  title: string;
  badge: string;
  description: string;
  tip?: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    badge: '1 / 4 • Cloud Execution Model',
    title: 'Zero-Install Cloud Sandbox',
    description:
      'CloudeeeIDE executes your code inside isolated Docker Linux containers. You do not need Python, GCC, Java, or Node installed on your computer.',
    tip: 'Tip: Every project gets its own private container with a 512MB RAM ceiling and 1.0 CPU quota.',
  },
  {
    badge: '2 / 4 • Smart Language Detection',
    title: 'Monaco Editor & Toolchains',
    description:
      'Select any source file in the left File Explorer (e.g. 1_welcome.py or 2_benchmark.c). The toolbar automatically detects the language and prepares the exact compiler or interpreter.',
    tip: 'Tip: Press Ctrl+S (Cmd+S on Mac) to save files anytime.',
  },
  {
    badge: '3 / 4 • Real-Time Streaming Output',
    title: 'Run Code in <50ms',
    description:
      'Click the Run button (or press Ctrl+Enter) in the top toolbar. Standard output, error streams, and exit codes stream back live over WebSocket.',
    tip: 'Tip: Interactive programs can accept typed input directly in the output bar.',
  },
  {
    badge: '4 / 4 • Sandboxed Web Preview & Shell',
    title: 'Live Web Servers & Terminal',
    description:
      'Running a web server (like 3_web_server.js on port 3000)? Switch to the Web Preview tab to view it live in an embedded browser. Access full Linux bash in the Terminal tab.',
    tip: 'Tip: You are now ready to test the demo workspace!',
  },
];

interface TourProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Tour({ isOpen, onClose }: TourProps) {
  const [currentStep, setCurrentStep] = useState(0);

  if (!isOpen) return null;

  const step = TOUR_STEPS[currentStep];
  const isLast = currentStep === TOUR_STEPS.length - 1;

  const next = () => {
    if (isLast) {
      onClose();
    } else {
      setCurrentStep(currentStep + 1);
    }
  };

  const prev = () => {
    if (currentStep > 0) setCurrentStep(currentStep - 1);
  };

  return (
    <div className="glass-modal-backdrop" onClick={onClose} style={{ zIndex: 10000 }}>
      <div
        className="glass-floating"
        style={{
          width: '460px',
          maxWidth: '92vw',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          border: '1px solid rgba(137, 180, 250, 0.3)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.6), 0 0 24px rgba(137, 180, 250, 0.25)',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="glass-badge glass-badge-accent" style={{ fontSize: '11px', padding: '3px 8px' }}>
            <IconSparkles size={11} />
            <span>{step.badge}</span>
          </span>
          <button
            className="glass-btn glass-btn-icon"
            onClick={onClose}
            title="Close Tour (Esc)"
            aria-label="Close Tour"
          >
            <IconClose size={12} />
          </button>
        </div>

        {/* Content */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <h3 id="tour-title" style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--fg-primary)' }}>
            {step.title}
          </h3>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--fg-secondary)', lineHeight: 1.5 }}>
            {step.description}
          </p>
          {step.tip && (
            <div
              style={{
                marginTop: '4px',
                padding: '8px 12px',
                background: 'rgba(137, 180, 250, 0.08)',
                borderLeft: '3px solid var(--accent)',
                borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
                fontSize: 'var(--text-xs)',
                color: 'var(--fg-muted)',
              }}
            >
              {step.tip}
            </div>
          )}
        </div>

        {/* Step Progress Dots & Controls */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            {TOUR_STEPS.map((_, i) => (
              <span
                key={i}
                style={{
                  width: i === currentStep ? '18px' : '6px',
                  height: '6px',
                  borderRadius: '3px',
                  background: i === currentStep ? 'var(--accent)' : 'var(--glass-border-light)',
                  transition: 'all 200ms ease',
                }}
              />
            ))}
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            {currentStep > 0 && (
              <button className="glass-btn" onClick={prev} style={{ padding: '6px 12px', fontSize: '12px' }}>
                Back
              </button>
            )}
            <button
              className="glass-btn glass-btn-primary"
              onClick={next}
              autoFocus
              style={{ padding: '6px 14px', fontSize: '12px' }}
            >
              <span>{isLast ? 'Get Started' : 'Next Step'}</span>
              {!isLast ? <IconChevronRight size={12} /> : <IconCheck size={12} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
