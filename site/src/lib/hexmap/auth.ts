// Google sign-in for the map editor. Anyone can view maps; only accounts with a document in
// MineAwareNTS_Editors (document ID = their email) can write — enforced by Firestore rules,
// this module just tells the UI whether to offer editing.
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { app, db } from '../firebase';
import { EDITORS_COLLECTION } from './model';

export const auth = getAuth(app);

export interface EditorStatus {
  user: User | null;
  isEditor: boolean;
}

export function signInWithGoogle() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export function signOutUser() {
  return signOut(auth);
}

async function checkEditor(user: User | null): Promise<boolean> {
  if (!user?.email) return false;
  try {
    const snap = await getDoc(doc(db, EDITORS_COLLECTION, user.email));
    return snap.exists();
  } catch {
    return false; // rules deny reading another account's entry, which also means "not an editor"
  }
}

export function watchEditorStatus(callback: (status: EditorStatus) => void) {
  return onAuthStateChanged(auth, async (user) => {
    callback({ user, isEditor: await checkEditor(user) });
  });
}

/** Renders the sign-in / signed-in-as control into `container`. */
export function renderAuthControl(container: HTMLElement, status: EditorStatus) {
  container.innerHTML = '';
  if (!status.user) {
    const btn = document.createElement('button');
    btn.className = 'hm-btn';
    btn.textContent = 'Sign in with Google';
    btn.addEventListener('click', () => {
      signInWithGoogle().catch((err) => {
        if (err?.code !== 'auth/popup-closed-by-user') alert(`Sign-in failed: ${err?.message ?? err}`);
      });
    });
    container.appendChild(btn);
    return;
  }
  const label = document.createElement('span');
  label.className = 'hm-auth-label';
  label.textContent = status.isEditor ? status.user.email ?? '' : `${status.user.email} (view only)`;
  label.title = status.isEditor ? 'You can edit maps' : 'This account is not on the editor list';
  const btn = document.createElement('button');
  btn.className = 'hm-btn hm-btn-quiet';
  btn.textContent = 'Sign out';
  btn.addEventListener('click', () => signOutUser());
  container.append(label, btn);
}
