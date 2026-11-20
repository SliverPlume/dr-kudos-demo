export function MessageStatus({ pending, failed, readAt }: { pending?: boolean; failed?: boolean; readAt: string | null }) {
  const label = failed ? 'Failed' : pending ? 'Sending' : readAt ? 'Read' : 'Sent';
  return (
    <span className={`message-status ${label.toLowerCase()}`} title={label} role="img" aria-label={label}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {failed ? <><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4M8 11.5h.01" /></>
          : pending ? <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>
          : readAt ? <><path d="m1 8 3 3 6-7" /><path d="m7 10 1 1 6-7" /></>
          : <path d="m3 8 3 3 7-7" />}
      </svg>
    </span>
  );
}
