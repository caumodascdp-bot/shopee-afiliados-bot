// ==============================================================================
// Controlador de Autenticação Administrativa
// ==============================================================================

function createAuthController({ repository, auth }) {
  async function login(req, res, next) {
    try {
      const username = String(req.body?.username || 'admin').trim() || 'admin';
      const password = String(req.body?.password || '');

      if (!password) {
        return res.status(400).json({ error: 'Informe a senha de acesso.', code: 'MISSING_PASSWORD' });
      }

      const user = await repository.getAdminByUsername(username);
      if (!user || !auth.verifyAdminPassword(password, user)) {
        await repository.addAuditLog({
          actor: username,
          action: 'auth.login_failed',
          resource: 'admin_users',
          details: {},
          ipAddress: req.ip || '',
        });
        return res.status(401).json({ error: 'Usuário ou senha inválidos.', code: 'INVALID_CREDENTIALS' });
      }

      auth.issueSessionCookie(res, user);
      await repository.addAuditLog({
        actor: user.username,
        action: 'auth.login_success',
        resource: 'admin_users',
        details: { mustChangePassword: Boolean(user.must_change_password) },
        ipAddress: req.ip || '',
      });

      return res.json({
        ok: true,
        user: {
          username: user.username,
          mustChangePassword: Boolean(user.must_change_password),
        },
      });
    } catch (err) {
      return next(err);
    }
  }

  async function logout(req, res) {
    auth.clearSessionCookie(res);
    return res.json({ ok: true });
  }

  async function me(req, res) {
    return res.json({
      ok: true,
      user: req.adminUser,
    });
  }

  async function changePassword(req, res, next) {
    try {
      const currentPassword = String(req.body?.currentPassword || '');
      const newPassword = String(req.body?.newPassword || '');

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Informe a senha atual e a nova senha.', code: 'MISSING_FIELDS' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ error: 'A nova senha deve ter pelo menos 8 caracteres.', code: 'WEAK_PASSWORD' });
      }
      if (newPassword === currentPassword) {
        return res.status(400).json({ error: 'A nova senha deve ser diferente da senha atual.', code: 'SAME_PASSWORD' });
      }

      const user = await repository.getAdminByUsername(req.adminUser.username);
      if (!user || !auth.verifyAdminPassword(currentPassword, user)) {
        return res.status(401).json({ error: 'Senha atual incorreta.', code: 'INVALID_CURRENT_PASSWORD' });
      }

      const nextHash = auth.hashPassword(newPassword);
      const updated = await repository.upsertAdminUser({
        username: user.username,
        passwordHash: nextHash,
        mustChangePassword: false,
      });

      auth.issueSessionCookie(res, updated);
      await repository.addAuditLog({
        actor: user.username,
        action: 'auth.password_changed',
        resource: 'admin_users',
        details: {},
        ipAddress: req.ip || '',
      });

      return res.json({
        ok: true,
        user: {
          username: updated.username,
          mustChangePassword: false,
        },
      });
    } catch (err) {
      return next(err);
    }
  }

  return { login, logout, me, changePassword };
}

module.exports = { createAuthController };
