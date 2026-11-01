import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/state/auth-store';
import { startSession } from '@/state/session';
import { authApi } from '@/services/auth-api';
import { loginDemo } from '@/services/demo-auth';
import { problemMessage } from '@/lib/api';
import { API_MODE } from '@/config';

const loginSchema = z.object({
  email: z.string().email('Ingresa un correo válido.'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.'),
});

type LoginValues = z.infer<typeof loginSchema>;

const demoAccounts = [
  { email: 'admin@toka.local', role: 'Admin' },
  { email: 'auditor@toka.local', role: 'Auditor' },
  { email: 'viewer@toka.local', role: 'Solo lectura' },
];

export function LoginPage() {
  const status = useAuthStore((state) => state.status);
  const error = useAuthStore((state) => state.error);
  const setLoading = useAuthStore((state) => state.setLoading);
  const setError = useAuthStore((state) => state.setError);
  const navigate = useNavigate();
  const location = useLocation();
  const destination = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';
  const { register, handleSubmit, setValue, formState: { errors } } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function submit(values: LoginValues) {
    setLoading();
    try {
      const result = API_MODE === 'real'
        ? await authApi.login(values)
        : await loginDemo(values);
      startSession(result.user, result.accessToken);
      navigate(destination, { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error && !('isAxiosError' in submitError)
        ? submitError.message
        : problemMessage(submitError));
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <Link className="brand login-brand" to="/" aria-label="Toka">
          <span className="brand-mark">t</span><span>toka<span className="brand-dot">.</span></span>
        </Link>
        <p className="eyebrow">PLATAFORMA DE GESTIÓN</p>
        <h1>Qué bueno verte.</h1>
        <p className="muted">Inicia sesión para continuar a tu espacio de trabajo.</p>
        <form className="login-form" onSubmit={handleSubmit(submit)} noValidate>
          <label htmlFor="email">Correo electrónico</label>
          <input id="email" type="email" autoComplete="username" placeholder="tu@empresa.com" {...register('email')} />
          {errors.email && <span className="field-error">{errors.email.message}</span>}
          <label htmlFor="password">Contraseña</label>
          <input id="password" type="password" autoComplete="current-password" placeholder="••••••••" {...register('password')} />
          {errors.password && <span className="field-error">{errors.password.message}</span>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button button-primary login-submit" type="submit" disabled={status === 'loading'}>
            {status === 'loading' ? 'Entrando…' : 'Iniciar sesión'}
            {status !== 'loading' && <span aria-hidden="true">→</span>}
          </button>
        </form>
        {API_MODE !== 'real' && (
          <div className="demo-box">
            <div className="demo-heading"><span className="status-dot" /> Acceso de demostración</div>
            <p>Selecciona un perfil. Usa cualquier contraseña de 8 caracteres o más.</p>
            <div className="demo-accounts">
              {demoAccounts.map((account) => (
                <button key={account.email} type="button" onClick={() => {
                  setValue('email', account.email);
                  setValue('password', 'toka-demo-2026');
                }}>
                  <span>{account.role}</span><span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="login-legal">Acceso seguro · Autorización basada en permisos</p>
      </section>
      <aside className="login-aside">
        <div className="orb orb-one" /><div className="orb orb-two" />
        <div className="aside-copy">
          <span className="eyebrow">IDENTIDAD. CONTROL. CONFIANZA.</span>
          <h2>Todo en orden.<br />Todo bajo control.</h2>
          <p>Una plataforma para gestionar accesos y equipos con claridad.</p>
        </div>
        <div className="aside-bottom"><span>01</span><div /><span>ADMIN CONSOLE</span></div>
      </aside>
    </main>
  );
}
