import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

export function usePermission() {
  const auth = useAuthStore()

  const isAdmin = computed(() => auth.user?.roles.includes('admin') ?? false)

  function hasRole(role: string): boolean {
    return auth.user?.roles.includes(role) ?? false
  }

  function hasAnyRole(...roles: string[]): boolean {
    if (!auth.user?.roles) return false
    return auth.user.roles.some(r => roles.includes(r))
  }

  // Check view/table/field permissions from the user's loaded permissions
  function canRead(resourceType: 'view' | 'table' | 'field', resourceId: string): boolean {
    if (isAdmin.value) return true
    const perm = auth.permissions.find(
      p => p.resource_type === resourceType && p.resource_id === resourceId
    )
    return perm?.can_read === 1
  }

  function canWrite(resourceType: 'view' | 'table' | 'field', resourceId: string): boolean {
    if (isAdmin.value) return true
    const perm = auth.permissions.find(
      p => p.resource_type === resourceType && p.resource_id === resourceId
    )
    return perm?.can_write === 1
  }

  // Check if user can see a specific field on a table
  function canReadField(tableId: string, fieldId: number): boolean {
    if (isAdmin.value) return true
    return canRead('field', `${tableId}.${fieldId}`)
  }

  function canWriteField(tableId: string, fieldId: number): boolean {
    if (isAdmin.value) return true
    return canWrite('field', `${tableId}.${fieldId}`)
  }

  return {
    isAdmin,
    hasRole,
    hasAnyRole,
    canRead,
    canWrite,
    canReadField,
    canWriteField,
  }
}
