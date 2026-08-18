import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { OverviewPage } from '../Overview';
import { ScheduleForm } from '../ScheduleForm';
import { ScheduleDetailPage } from '../ScheduleDetail';
import { ConnectionPanel } from '../ConnectionPanel';
import './StaleBranchesPage.css';

/**
 * Every screen has its own path, so a link pasted into a chat opens what its
 * author was looking at rather than the default view. An unknown suffix lands
 * on the schedule list instead of dead-ending.
 */
export const StaleBranchesPage = () => (
  <Routes>
    <Route path="/" element={<OverviewPage />} />
    <Route path="/new" element={<ScheduleForm mode="create" />} />
    <Route path="/schedules/:id" element={<ScheduleDetailPage />} />
    <Route path="/schedules/:id/edit" element={<ScheduleForm mode="edit" />} />
    <Route path="/connection" element={<ConnectionPanel />} />
    <Route path="*" element={<Navigate to="." replace />} />
  </Routes>
);
