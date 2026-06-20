export default function SalesPage() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div
        className="w-full max-w-md text-center"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-xl)",
          boxShadow: "var(--shadow-sm)",
          padding: "40px 32px",
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em", margin: 0 }}>
          ประวัติการขาย
        </h1>
        <p style={{ margin: "6px 0 0", color: "var(--muted)", fontSize: 13 }}>
          Sales History
        </p>
        <p style={{ margin: "20px 0 0", color: "var(--soft)", fontSize: 12.5, lineHeight: 1.6 }}>
          จะพัฒนาในเฟสถัดไป
          <br />
          Coming in a later phase (Phase 5)
        </p>
      </div>
    </div>
  );
}
