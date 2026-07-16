const API_URL = '';

// Auth Check
const token = localStorage.getItem('rx-monitor-token');
if (!token) {
  window.location.href = '/';
}

const userStr = localStorage.getItem('rx-monitor-user');
if (userStr) {
  try {
    const user = JSON.parse(userStr);
    if (user.role !== 'admin') {
      window.location.href = '/';
    }
  } catch (e) {
    window.location.href = '/';
  }
}

// DOM Elements
const btnRefreshUsers = document.getElementById('btn-refresh-users');
const usersTbody = document.getElementById('users-list-tbody');
const toastEl = document.getElementById('toast');

// Modal Edit Elements
const modalEditUser = document.getElementById('modal-edit-user');
const editUserForm = document.getElementById('edit-user-form');
const editUserIdInput = document.getElementById('edit-user-id');
const editUserEmailInput = document.getElementById('edit-user-email');
const editUserRoleSelect = document.getElementById('edit-user-role');
const editUserTierSelect = document.getElementById('edit-user-tier');
const editUserVerifiedSelect = document.getElementById('edit-user-verified');

// Stats Elements
const statUsers = document.getElementById('admin-stat-users');
const statPremium = document.getElementById('admin-stat-premium');
const statRevenue = document.getElementById('admin-stat-revenue');
const statMonitors = document.getElementById('admin-stat-monitors');

function showToast(message, type = 'success') {
  toastEl.textContent = message;
  toastEl.className = `toast show toast-${type}`;
  setTimeout(() => {
    toastEl.classList.remove('show');
  }, 4000);
}

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_URL}/api/admin/stats`, { headers: getHeaders() });
    if (res.status === 401 || res.status === 403) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    statUsers.textContent = data.totalUsers;
    statPremium.textContent = data.premiumUsers;
    statRevenue.textContent = `₹${data.totalRevenue}`;
    statMonitors.textContent = data.totalMonitors;
  } catch (err) {
    showToast('Failed to load stats', 'error');
  }
}

async function fetchUsers() {
  try {
    usersTbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--color-muted); padding: 30px;">Loading users list...</td></tr>`;
    const res = await fetch(`${API_URL}/api/admin/users`, { headers: getHeaders() });
    if (res.status === 401 || res.status === 403) {
      window.location.href = '/';
      return;
    }
    const users = await res.json();
    
    if (users.length === 0) {
      usersTbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--color-muted); padding: 30px;">No registered accounts.</td></tr>`;
      return;
    }

    usersTbody.innerHTML = users.map(user => {
      const regDate = new Date(user.created_at).toLocaleDateString();
      const verifiedBadge = user.is_verified 
        ? `<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);">Yes</span>`
        : `<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);">No</span>`;
      
      const tierBadge = user.subscription_tier === 'premium'
        ? `<span class="badge" style="background: rgba(99, 102, 241, 0.15); color: #6366f1; border: 1px solid rgba(99, 102, 241, 0.3);">Premium</span>`
        : `<span class="badge" style="background: rgba(255, 255, 255, 0.05); color: var(--color-muted); border: 1px solid var(--border-color);">Free</span>`;

      return `
        <tr>
          <td>${regDate}</td>
          <td style="font-weight: 500;">${user.email}</td>
          <td><span style="text-transform: capitalize;">${user.role}</span></td>
          <td>${verifiedBadge}</td>
          <td>${tierBadge}</td>
          <td style="text-align: center; font-weight: 600;">${user.monitor_count}</td>
          <td>
            <button class="btn btn-secondary btn-edit" data-id="${user.id}" data-email="${user.email}" data-role="${user.role}" data-tier="${user.subscription_tier}" data-verified="${user.is_verified}" style="padding: 6px 12px; font-size: 12px;">Edit</button>
            <button class="btn btn-danger btn-delete" data-id="${user.id}" style="padding: 6px 12px; font-size: 12px;">Delete</button>
          </td>
        </tr>
      `;
    }).join('');

    setupTableActions();
  } catch (err) {
    showToast('Failed to load users', 'error');
  }
}

function setupTableActions() {
  document.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const data = e.target.dataset;
      editUserIdInput.value = data.id;
      editUserEmailInput.value = data.email;
      editUserRoleSelect.value = data.role;
      editUserTierSelect.value = data.tier;
      editUserVerifiedSelect.value = data.verified;
      modalEditUser.classList.add('active');
    });
  });

  document.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const userId = e.target.dataset.id;
      if (confirm('Are you absolutely sure you want to delete this user account? All their monitors, logs, and payment details will be deleted permanently.')) {
        try {
          const res = await fetch(`${API_URL}/api/admin/users/${userId}`, {
            method: 'DELETE',
            headers: getHeaders()
          });
          if (res.ok) {
            showToast('User account deleted successfully.');
            fetchStats();
            fetchUsers();
          } else {
            const data = await res.json();
            showToast(data.error || 'Failed to delete user account.', 'error');
          }
        } catch (err) {
          showToast('Network error.', 'error');
        }
      }
    });
  });
}

// Modal closing
document.querySelectorAll('.close-modal').forEach(btn => {
  btn.addEventListener('click', () => {
    modalEditUser.classList.remove('active');
  });
});

editUserForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = editUserIdInput.value;
  const role = editUserRoleSelect.value;
  const subscription_tier = editUserTierSelect.value;
  const is_verified = parseInt(editUserVerifiedSelect.value);

  try {
    const res = await fetch(`${API_URL}/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ role, subscription_tier, is_verified })
    });
    
    if (res.ok) {
      showToast('User settings updated successfully.');
      modalEditUser.classList.remove('active');
      fetchStats();
      fetchUsers();
    } else {
      const data = await res.json();
      showToast(data.error || 'Failed to update settings.', 'error');
    }
  } catch (err) {
    showToast('Network error.', 'error');
  }
});

btnRefreshUsers.addEventListener('click', () => {
  fetchStats();
  fetchUsers();
});

// Initial load
fetchStats();
fetchUsers();
