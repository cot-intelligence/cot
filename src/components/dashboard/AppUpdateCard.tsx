import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { installAppUpdate, mb, useAppUpdate } from '../../lib/appUpdates';

const LATER_KEY = 'cot.appUpdate.later';

function laterVersion(): string | null {
  try {
    return localStorage.getItem(LATER_KEY);
  } catch {
    return null;
  }
}

/**
 * The Mac app's update prompt: shows when the app has found a newer version,
 * and follows the download and install until cot restarts. "Later" hides it
 * for that version; Settings → About can still install it.
 */
export function AppUpdateCard() {
  const { update: u, refresh } = useAppUpdate();
  const [later, setLater] = useState(laterVersion);
  const reduce = useReducedMotion();
  const moving = u?.status === 'downloading' || u?.status === 'installing';
  const show = !!u?.version && (moving || (u.status === 'available' && later !== u.version) || (u.status === 'failed' && later !== u.version));

  const install = async () => {
    try {
      await installAppUpdate();
    } finally {
      void refresh();
    }
  };
  const dismiss = () => {
    if (!u?.version) return;
    try {
      localStorage.setItem(LATER_KEY, u.version);
    } catch {
      /* ignore */
    }
    setLater(u.version);
  };
  const share = u?.total ? Math.min(1, u.downloaded / u.total) : 0;

  return (
    <AnimatePresence>
      {show && u && (
        <motion.section
          className="upd"
          role="status"
          aria-label="cot update"
          initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(8px)' }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0px)' }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(4px)' }}
          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}>
          <div className="upd-h">
            <span className="wordmark upd-mark" aria-hidden="true">c<i>.</i></span>
            <div style={{ minWidth: 0 }}>
              <div className="upd-t">cot {u.version} is ready</div>
              <div className="upd-s">You have {u.current}</div>
            </div>
          </div>
          {u.notes && u.status === 'available' && <p className="upd-n">{u.notes}</p>}
          {moving && (
            <div className="upd-p">
              <div className="upd-bar" aria-hidden="true"><span style={{ transform: `scaleX(${u.status === 'installing' ? 1 : share})` }} /></div>
              <div className="upd-s mono">
                {u.status === 'installing' ? 'Installing. cot will restart.' : u.total ? `Downloading ${mb(u.downloaded)} of ${mb(u.total)}` : `Downloading ${mb(u.downloaded)}`}
              </div>
            </div>
          )}
          {u.status === 'failed' && u.error && <p className="upd-n upd-err">{u.error}</p>}
          {!moving && (
            <div className="upd-a">
              <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={dismiss}>Later</button>
              <button type="button" className="vbtn vbtn-primary vbtn-sm" onClick={() => void install()}>
                {u.status === 'failed' ? 'Try again' : 'Install and restart'}
              </button>
            </div>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
