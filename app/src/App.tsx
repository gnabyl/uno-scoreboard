import { lazy, Suspense } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { Navigate, Route, Routes } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import { useTranslation } from './i18n';

// RoomPage pulls in its own heavy dependencies (onnxruntime-web, the Supabase
// realtime client, RoomBoard). Split it into a separate chunk so the landing
// page - the default route - ships a much smaller initial payload. LandingPage
// stays eager so it renders without an extra network round-trip.
const RoomPage = lazy(() => import('./pages/RoomPage'));

function RouteFallback() {
  const t = useTranslation();
  return (
    <div className="flex min-h-dvh items-center justify-center text-muted">
      <div
        className="h-10 w-10 animate-spin rounded-full border-4 border-edge border-t-accent [animation-duration:0.8s]"
        aria-label={t('room.loading')}
      />
    </div>
  );
}

export default function App() {
  return (
    <>
      <Analytics />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/r/:code" element={<RoomPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
