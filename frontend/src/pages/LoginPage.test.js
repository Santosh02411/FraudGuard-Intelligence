import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from './LoginPage';

const mockLogin = jest.fn();
const mockVerifyMfaLogin = jest.fn();
const mockRegister = jest.fn();
const mockNavigate = jest.fn();
const mockApiPost = jest.fn();
const mockApiGet = jest.fn();
let mockNotice = '';

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login: mockLogin, verifyMfaLogin: mockVerifyMfaLogin, register: mockRegister }),
  api: { post: (...args) => mockApiPost(...args), get: (...args) => mockApiGet(...args), defaults: { baseURL: 'http://localhost:5000/api/v1' } },
  takeSessionNotice: () => mockNotice,
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

function renderLoginPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockLogin.mockReset();
  mockVerifyMfaLogin.mockReset();
  mockRegister.mockReset();
  mockNavigate.mockReset();
  mockApiPost.mockReset();
  mockApiGet.mockReset(); mockApiGet.mockResolvedValue({ data: { status: 'ok' } });
  mockNotice = '';
});

describe('LoginPage', () => {
  test('renders the login form by default (no email field)', () => {
    renderLoginPage();
    expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter password')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Enter email')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  test('switching to register mode reveals the email field and password hint', async () => {
    renderLoginPage();
    await userEvent.click(screen.getByRole('button', { name: /^register$/i }));

    expect(screen.getByPlaceholderText('Enter email')).toBeInTheDocument();
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  test('submitting the login form calls login() with the entered credentials and navigates on success', async () => {
    mockLogin.mockResolvedValue({ mfaRequired: false, user: { id: 1, username: 'alice' } });
    renderLoginPage();

    await userEvent.type(screen.getByPlaceholderText('Enter username'), 'alice');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'Str0ng!Passw0rd');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('alice', 'Str0ng!Passw0rd'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard'));
  });

  test('a failed login shows the server error message and does not navigate', async () => {
    mockLogin.mockRejectedValue({ response: { data: { error: 'Invalid credentials' } } });
    renderLoginPage();

    await userEvent.type(screen.getByPlaceholderText('Enter username'), 'alice');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'WrongPassword1!');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('a weak-password validation error joins every failing rule into one message', async () => {
    mockRegister.mockRejectedValue({
      response: {
        data: {
          error: 'Validation failed',
          details: [
            { field: 'password', message: 'Password must include an uppercase letter' },
            { field: 'password', message: 'Password must include a number' },
          ],
        },
      },
    });
    renderLoginPage();
    await userEvent.click(screen.getByRole('button', { name: /^register$/i }));

    await userEvent.type(screen.getByPlaceholderText('Enter username'), 'newuser');
    await userEvent.type(screen.getByPlaceholderText('Enter email'), 'new@example.com');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'weak');
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/uppercase letter/i)).toBeInTheDocument();
    expect(screen.getByText(/a number/i)).toBeInTheDocument();
  });

  test('shows the default admin credentials hint only in login mode', async () => {
    renderLoginPage();
    expect(screen.getByText(/default admin/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^register$/i }));
    expect(screen.queryByText(/default admin/i)).not.toBeInTheDocument();
  });

  test('a login response with mfaRequired shows the 2FA code step instead of navigating', async () => {
    mockLogin.mockResolvedValue({ mfaRequired: true, mfaToken: 'challenge-token-123' });
    renderLoginPage();

    await userEvent.type(screen.getByPlaceholderText('Enter username'), 'mfauser');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'Str0ng!Passw0rd');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/two-factor verification/i)).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('submitting the 2FA code calls verifyMfaLogin with the challenge token and code, then navigates', async () => {
    mockLogin.mockResolvedValue({ mfaRequired: true, mfaToken: 'challenge-token-123' });
    mockVerifyMfaLogin.mockResolvedValue({ user: { id: 1, username: 'mfauser' } });
    renderLoginPage();

    await userEvent.type(screen.getByPlaceholderText('Enter username'), 'mfauser');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'Str0ng!Passw0rd');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByText(/two-factor verification/i);

    await userEvent.type(screen.getByPlaceholderText('123456'), '654321');
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    await waitFor(() => expect(mockVerifyMfaLogin).toHaveBeenCalledWith('challenge-token-123', '654321'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard'));
  });

  test('an invalid 2FA code shows the server error without navigating', async () => {
    mockLogin.mockResolvedValue({ mfaRequired: true, mfaToken: 'challenge-token-123' });
    mockVerifyMfaLogin.mockRejectedValue({ response: { data: { error: 'Invalid authentication code' } } });
    renderLoginPage();

    await userEvent.type(screen.getByPlaceholderText('Enter username'), 'mfauser');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'Str0ng!Passw0rd');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByText(/two-factor verification/i);

    await userEvent.type(screen.getByPlaceholderText('123456'), '000000');
    fireEvent.click(screen.getByRole('button', { name: /^verify$/i }));

    expect(await screen.findByText('Invalid authentication code')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('"Back to login" from the 2FA step returns to the username/password form', async () => {
    mockLogin.mockResolvedValue({ mfaRequired: true, mfaToken: 'challenge-token-123' });
    renderLoginPage();

    await userEvent.type(screen.getByPlaceholderText('Enter username'), 'mfauser');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'Str0ng!Passw0rd');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByText(/two-factor verification/i);

    fireEvent.click(screen.getByRole('button', { name: /back to login/i }));
    expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
  });

  test('"Forgot password?" switches to the forgot-password form, and submitting calls the API with the email', async () => {
    mockApiPost.mockResolvedValue({ data: { message: 'If an account with that email exists, a password reset link has been sent.' } });
    renderLoginPage();

    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }));
    expect(screen.getByText(/reset your password/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Enter username')).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Enter email'), 'alice@example.com');
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/auth/forgot-password', { email: 'alice@example.com' }));
    expect(await screen.findByText(/reset link has been sent/i)).toBeInTheDocument();
  });
});

describe('Try demo', () => {
  test('sign in screen offers a Try demo link to the static demo (a real link, not a router route)', () => {
    renderLoginPage();
    const link = screen.getByTestId('try-demo');
    expect(link).toHaveAttribute('href', '/demo/');
    expect(link).toHaveTextContent(/try demo/i);
    expect(screen.getByText(/nothing is saved/i)).toBeInTheDocument();
  });

  test('it is also available on the register tab, and hidden while resetting a password', async () => {
    renderLoginPage();
    await userEvent.click(screen.getByRole('button', { name: /^register$/i }));
    expect(screen.getByTestId('try-demo')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^login$/i }));
    await userEvent.click(screen.getByText(/forgot password/i));
    expect(screen.queryByTestId('try-demo')).not.toBeInTheDocument();
  });

  test('clicking it never calls the auth API', async () => {
    renderLoginPage();
    const link = screen.getByTestId('try-demo'); link.addEventListener('click', (e) => e.preventDefault()); // jsdom cannot navigate
    await userEvent.click(link);
    expect(mockLogin).not.toHaveBeenCalled(); expect(mockRegister).not.toHaveBeenCalled(); expect(mockApiPost).not.toHaveBeenCalled();
  });
});

describe('sign-in diagnostics', () => {
  test('shows "Backend connected" when the API answers', async () => {
    renderLoginPage();
    expect(await screen.findByText(/backend connected/i)).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith('/health', expect.anything());
  });

  test('says clearly when the backend is not reachable, and how to start it', async () => {
    mockApiGet.mockRejectedValue(new Error('Network Error'));
    renderLoginPage();
    const status = await screen.findByTestId('backend-status');
    await waitFor(() => expect(status).toHaveTextContent(/backend not reachable at http:\/\/localhost:5000/i));
    expect(status).toHaveTextContent(/npm start/);
  });

  test('a sign-in attempt that never reaches the server explains why instead of "Something went wrong"', async () => {
    mockLogin.mockRejectedValue(Object.assign(new Error('Network Error'), { response: undefined }));
    renderLoginPage();
    await userEvent.type(screen.getByPlaceholderText('Enter username'), 'admin');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'admin123');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByText(/cannot reach the server at http:\/\/localhost:5000/i)).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  test('a real server answer (wrong password) still shows the server message', async () => {
    mockLogin.mockRejectedValue({ response: { status: 401, data: { error: 'Invalid credentials' } } });
    renderLoginPage();
    await userEvent.type(screen.getByPlaceholderText('Enter username'), 'admin');
    await userEvent.type(screen.getByPlaceholderText('Enter password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
  });

  test('shows the "session expired" notice once after an automatic sign-out', () => {
    mockNotice = 'Your session expired. Please sign in again.';
    renderLoginPage();
    expect(screen.getByTestId('session-notice')).toHaveTextContent(/session expired/i);
  });

  test('no notice on a normal visit, and the build marker is always visible', () => {
    renderLoginPage();
    expect(screen.queryByTestId('session-notice')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-build')).toHaveTextContent('FraudGuard build v3');
  });
});
