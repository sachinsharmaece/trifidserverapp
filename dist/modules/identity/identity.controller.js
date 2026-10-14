import * as authService from './auth.service.js';
import { setRefreshTokenCookie, clearRefreshTokenCookie, readRefreshTokenCookie, } from './identity.cookies.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
export async function otpRequest(req, res) {
    const { mobile } = req.body;
    const result = await authService.requestOtp(mobile, req.ip ?? 'unknown');
    ok(res, req, result);
}
export async function otpVerify(req, res) {
    const { requestId, code, deviceFingerprint } = req.body;
    const result = await authService.verifyOtp(requestId, code, deviceFingerprint, req.correlationId);
    if (result.refreshToken)
        setRefreshTokenCookie(res, result.refreshToken);
    ok(res, req, { accessToken: result.accessToken, me: result.me });
}
export async function staffLogin(req, res) {
    const { email, password } = req.body;
    const result = await authService.staffLogin(email, password);
    if (result.mfaRequired) {
        ok(res, req, { mfaRequired: true, mfaToken: result.mfaToken, expiresIn: result.expiresIn });
        return;
    }
    if (result.refreshToken)
        setRefreshTokenCookie(res, result.refreshToken);
    ok(res, req, { mfaRequired: false, accessToken: result.accessToken, me: result.me });
}
export async function staffMfaVerify(req, res) {
    const { mfaToken, code } = req.body;
    const result = await authService.staffMfaVerify(mfaToken, code, req.correlationId);
    setRefreshTokenCookie(res, result.refreshToken);
    ok(res, req, { accessToken: result.accessToken, me: result.me });
}
export async function refresh(req, res) {
    const presented = readRefreshTokenCookie(req);
    if (!presented) {
        clearRefreshTokenCookie(res);
        res.status(401).json({
            error: {
                code: 'SESSION_REPLACED',
                message_en: 'Session expired. Sign in again.',
                retryable: false,
                correlationId: req.correlationId,
            },
        });
        return;
    }
    const result = await authService.refreshSession(presented);
    setRefreshTokenCookie(res, result.refreshToken);
    ok(res, req, { accessToken: result.accessToken });
}
export async function logout(req, res) {
    const { allDevices } = req.body;
    const presented = readRefreshTokenCookie(req);
    await authService.logout(presented, allDevices ?? false);
    clearRefreshTokenCookie(res);
    ok(res, req, { loggedOut: true });
}
export async function reauth(req, res) {
    const { password, mfaCode } = req.body;
    const employeeId = req.auth.employeeId;
    const result = await authService.reauth(employeeId, password, mfaCode);
    ok(res, req, result);
}
export async function me(req, res) {
    const result = await authService.getMe(req.auth);
    ok(res, req, result);
}
