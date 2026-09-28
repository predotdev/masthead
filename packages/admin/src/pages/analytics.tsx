import { useEffect, useState } from 'preact/hooks';
import { Loading, errorToast } from '../ui';

// Charts and reports load on first visit, so the rest of the admin stays small.
type AnalyticsModule = typeof import('./analytics-page');
let loaded: AnalyticsModule | null = null;

export function Analytics() {
    const [mod, setMod] = useState(loaded);
    useEffect(() => {
        if (!mod) import('./analytics-page').then(m => setMod((loaded = m)), errorToast);
    }, []);
    return mod ? <mod.Analytics /> : <Loading />;
}
